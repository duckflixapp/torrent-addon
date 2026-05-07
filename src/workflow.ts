import path from 'node:path';
import fs from 'node:fs/promises';
import { isTorrentCanceledError, TorrentClient, validateTorrentFileSize } from './utils/torrent';
import { RqbitClient } from './lib/rqbit';
import type { TorrentFile } from './torrent.types';
import type { AddonErrorFactory, DownloadProgress, VideoProcessorContext, VideoProcessorStartItem } from '@duckflixapp/addon-sdk';

const createTorrentDownloadError = (error: AddonErrorFactory, cause: unknown) => {
    const causeDetails = cause as { message?: string; code?: string };
    let friendlyMessage = 'Torrent could not be downloaded';
    if (causeDetails?.message?.includes('no peers')) friendlyMessage = 'No active seeders found for this torrent.';
    if (causeDetails?.code === 'ENOSPC') friendlyMessage = 'Not enough disk space for download.';

    return error(friendlyMessage, { cause, statusCode: 400 });
};

const isVideoFile = (name: string) => {
    const allowed = ['.mkv', '.mp4', '.avi', '.mov'];
    const lowerName = name.toLowerCase();
    return allowed.some((ext) => lowerName.endsWith(ext));
};

export type ScannedTorrentFile = TorrentFile & { torrentIndex: number };

const parseTorrentFileIndex = (id: string) => {
    const index = Number(id.split(':').at(-1));
    return Number.isInteger(index) && index >= 0 ? index : null;
};

const getTorrentFilePath = (rootDir: string, file: TorrentFile) => {
    const relativePath = file.components.length > 0 ? path.join(...file.components) : file.name;
    const resolvedRoot = path.resolve(rootDir);
    const resolvedPath = path.resolve(resolvedRoot, relativePath);

    if (resolvedPath !== resolvedRoot && resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
        return resolvedPath;
    }

    throw new Error(`Torrent file path escaped output folder: ${file.name}`);
};

export const scanTorrentFileWorkflow = async (
    data: { torrentPath: string },
    context: VideoProcessorContext
): Promise<{ infoHash: string; name: string; files: ScannedTorrentFile[] }> => {
    const error = context.error.bind(context);

    const scanOutputFolder = context.workspace?.workDir;

    let torrentBuffer: Buffer;
    try {
        const valid = await validateTorrentFileSize(data.torrentPath);
        if (!valid) throw error('Torrent file is too large', { statusCode: 400 });

        torrentBuffer = await fs.readFile(data.torrentPath);
    } catch (err) {
        throw err;
    }

    const rqbitUrl = process.env.RQBIT_URL ?? 'http://localhost:3030';
    const torrentClient = new TorrentClient({ rqbit: new RqbitClient({ baseUrl: rqbitUrl, error }), error });
    const torrent = await torrentClient.download(torrentBuffer, { outputFolder: scanOutputFolder, overwrite: false }).catch((e) => {
        context.emit({
            type: 'log',
            level: 'error',
            message: 'Torrent could not be scanned by rqbit',
            data: {
                rqbitUrl,
                err: e,
            },
        });
        throw createTorrentDownloadError(error, e);
    });

    const ownsTorrent = scanOutputFolder ? path.resolve(torrent.outputFolder) === path.resolve(scanOutputFolder) : false;
    context.emit({
        type: 'log',
        level: 'debug',
        data: { ownsTorrent, out: torrent.outputFolder, workOut: scanOutputFolder },
        message: 'Who owns torrent',
    });

    try {
        return {
            infoHash: torrent.infoHash,
            name: torrent.name,
            files: torrent.files.map((file, torrentIndex) => ({ ...file, torrentIndex })).filter((file) => isVideoFile(file.name)),
        };
    } finally {
        if (ownsTorrent) await torrent.destroy().catch(() => {});
    }
};

export const processTorrentFileWorkflow = async (
    data: { torrentPath: string; items: VideoProcessorStartItem[] },
    context: VideoProcessorContext
) => {
    const error = context.error.bind(context);
    if (!context.workspace) {
        throw error('Torrent processor requires a job workspace', { statusCode: 500 });
    }

    const workDir = context.workspace.workDir;

    let torrentBuffer: Buffer;
    try {
        const valid = await validateTorrentFileSize(data.torrentPath);
        if (!valid) throw error('Torrent file is too large', { statusCode: 400 });

        torrentBuffer = await fs.readFile(data.torrentPath);
    } catch (err) {
        throw err;
    } finally {
        await fs.unlink(data.torrentPath).catch(() => {});
    }

    const downloadPath = path.join(workDir, './downloads');
    await fs.mkdir(downloadPath, { recursive: true });

    const rqbitUrl = process.env.RQBIT_URL ?? 'http://localhost:3030';
    const torrentClient = new TorrentClient({ rqbit: new RqbitClient({ baseUrl: rqbitUrl, error }), error });
    const torrent = await torrentClient.download(torrentBuffer, { outputFolder: downloadPath, overwrite: true }).catch((e) => {
        context.emit({
            type: 'log',
            level: 'error',
            message: 'Torrent could not be added to rqbit',
            data: {
                rqbitUrl,
                downloadPath,
                err: e,
            },
        });
        throw createTorrentDownloadError(error, e);
    });
    context.download.register(torrent);

    torrent.addListener('progress', (progress) =>
        context.emit({ type: 'progress', phase: 'downloading', progress: progress satisfies DownloadProgress })
    );

    torrent.addListener('error', ({ error, code }) =>
        context.emit({
            type: 'log',
            level: 'debug',
            message: 'Torrent download status error',
            data: {
                err: error,
                errorCode: code,
                context: 'torrent_client',
            },
        })
    );

    try {
        context.emit({
            type: 'log',
            level: 'info',
            message: 'Torrent waiting for download...',
        });
        context.emit({
            type: 'status',
            status: 'started',
            title: 'Download started',
            message: `Torrent started downloading video`,
        });
        await torrent.waitDownload();
        context.emit({
            type: 'log',
            level: 'info',
            message: 'Torrent download finished...',
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
        fs.rm(downloadPath, { recursive: true, force: true }).catch(() => {});
        if (isTorrentCanceledError(err)) {
            context.emit({
                type: 'status',
                status: 'canceled',
                title: `Video download canceled`,
                message: `Torrent download was canceled.`,
            });
            throw err;
        }
        throw createTorrentDownloadError(error, err);
    } finally {
        context.download.unregister();
    }

    try {
        context.emit({
            type: 'status',
            status: 'downloaded',
            title: `Video downloaded`,
            message: `Video download completed. Processing...`,
        });
    } catch (e) {
        await fs.rm(downloadPath, { recursive: true, force: true }).catch(() => {});
        torrent.destroy().catch(() => {});
        throw error('Error changing video status and notifying', { cause: e });
    }

    let files;
    const outPath = context.workspace.outputDir;
    try {
        const selectedIndexes = new Set(data.items.map((item) => parseTorrentFileIndex(item.id)).filter((index) => index !== null));
        const selectedFiles = torrent.files
            .map((file, index) => ({ file, index }))
            .filter(({ file, index }) => isVideoFile(file.name) && (selectedIndexes.size === 0 || selectedIndexes.has(index)));

        await fs.mkdir(outPath).catch(() => {});
        files = await Promise.all(
            selectedFiles.map(async ({ file, index }) => {
                const downloadedPath = getTorrentFilePath(downloadPath, file);

                const ext = path.extname(file.name);
                const safePath = path.join(outPath, `${crypto.randomUUID()}-torrent${ext}`);

                context.emit({ type: 'log', data: { downloadedPath, safePath }, message: 'Copying...', level: 'debug' });
                await fs.rename(downloadedPath, safePath);

                return { id: `torrent:${torrent.infoHash}:${index}`, path: safePath, fileName: file.name, fileSize: file.length };
            })
        );
    } catch (e) {
        await fs.rm(outPath, { recursive: true, force: true }).catch(() => {});
        throw error('Video file(s) could not be copied after downloading', { cause: e });
    } finally {
        await fs.rm(downloadPath, { recursive: true, force: true }).catch(() => {});
        torrent.destroy().catch(() => {}); // ignore error
    }

    return files;
};
