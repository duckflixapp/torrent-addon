import path from 'node:path';
import fs from 'node:fs/promises';
import { isTorrentCanceledError, TorrentClient, validateTorrentFileSize } from './utils/torrent';
import { RqbitClient } from './lib/rqbit';
import type { AddonErrorFactory, DownloadProgress, VideoProcessorContext } from '@duckflixapp/addon-sdk';

const createTorrentDownloadError = (error: AddonErrorFactory, cause: unknown) => {
    const causeDetails = cause as { message?: string; code?: string };
    let friendlyMessage = 'Torrent could not be downloaded';
    if (causeDetails?.message?.includes('no peers')) friendlyMessage = 'No active seeders found for this torrent.';
    if (causeDetails?.code === 'ENOSPC') friendlyMessage = 'Not enough disk space for download.';

    return error(friendlyMessage, { cause, statusCode: 400 });
};

export const processTorrentFileWorkflow = async (data: { torrentPath: string }, context: VideoProcessorContext) => {
    const error = context.error.bind(context);
    const workDir = context.workspace?.workDir;
    if (!workDir) {
        throw error('Torrent processor requires a job workspace', { statusCode: 500 });
    }

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
    const torrent = await torrentClient.download(torrentBuffer, { outputFolder: workDir }).catch((e) => {
        context.emit({
            type: 'log',
            level: 'error',
            message: 'Torrent could not be added to rqbit',
            data: {
                rqbitUrl,
                workDir,
                err: e,
            },
        });
        throw createTorrentDownloadError(error, e);
    });
    const torrentDirPath = path.join(workDir, torrent.dir);
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
        fs.rm(torrentDirPath, { recursive: true, force: true }).catch(() => {});
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
        await fs.rm(torrentDirPath, { recursive: true, force: true }).catch(() => {});
        torrent.destroy().catch(() => {});
        throw error('Error changing video status and notifying', { cause: e });
    }

    let safePath, mainFile;
    try {
        mainFile = torrent.files.reduce((p, c) => (p.length > c.length ? p : c));
        const downloadedPath = path.join(torrentDirPath, mainFile.name);

        const ext = path.extname(mainFile.name);
        safePath = path.join(downloadPath, `${crypto.randomUUID()}-torrent${ext}`);
        await fs.rename(downloadedPath, safePath);
    } catch (e) {
        throw error('Video could not be copied after downloading', { cause: e });
    } finally {
        await fs.rm(torrentDirPath, { recursive: true, force: true }).catch(() => {});
        torrent.destroy().catch(() => {}); // ignore error
    }

    return { path: safePath, name: mainFile.name, size: mainFile.length };
};
