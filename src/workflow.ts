import path from 'node:path';
import fs from 'node:fs/promises';
import { TorrentCanceledError, TorrentClient, validateTorrentFileSize } from './utils/torrent';
import { RqbitClient } from './lib/rqbit';
import type { DownloadProgress, VideoProcessorContext } from '@duckflixapp/addon-sdk';
import { TorrentDownloadError, AppError } from './torrent.errors';

export class DownloadCancelledError extends Error {
    constructor() {
        super('cancelled-download');
        this.name = 'DownloadCancelledError';
    }
}

export const processTorrentFileWorkflow = async (data: { torrentPath: string }, context: VideoProcessorContext) => {
    const workDir = context.workspace?.workDir;
    if (!workDir) {
        throw new AppError('Torrent processor requires a job workspace', { statusCode: 500 });
    }

    let torrentBuffer: Buffer;
    try {
        const valid = await validateTorrentFileSize(data.torrentPath);
        if (!valid) throw new Error('Torrent file is too large');

        torrentBuffer = await fs.readFile(data.torrentPath);
    } catch (err) {
        throw err;
    } finally {
        await fs.unlink(data.torrentPath).catch(() => {});
    }

    const downloadPath = path.join(workDir, './downloads');
    await fs.mkdir(downloadPath, { recursive: true });

    const rqbitUrl = process.env.RQBIT_URL ?? 'http://localhost:3030';
    const torrentClient = new TorrentClient({ rqbit: new RqbitClient({ baseUrl: rqbitUrl }) });
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
        throw new TorrentDownloadError(e);
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
        if (err instanceof TorrentCanceledError) {
            context.emit({
                type: 'status',
                status: 'canceled',
                title: `Video download canceled`,
                message: `Torrent download was canceled.`,
            });
            throw new DownloadCancelledError();
        }
        throw new TorrentDownloadError(err);
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
        throw new AppError('Error changing video status and notifying', { cause: e });
    }

    let safePath, mainFile;
    try {
        mainFile = torrent.files.reduce((p, c) => (p.length > c.length ? p : c));
        const downloadedPath = path.join(torrentDirPath, mainFile.name);

        const ext = path.extname(mainFile.name);
        safePath = path.join(downloadPath, `${crypto.randomUUID()}-torrent${ext}`);
        await fs.rename(downloadedPath, safePath);
    } catch (e) {
        throw new AppError('Video could not be copied after downloading', { cause: e });
    } finally {
        await fs.rm(torrentDirPath, { recursive: true, force: true }).catch(() => {});
        torrent.destroy().catch(() => {}); // ignore error
    }

    return { path: safePath, name: mainFile.name, size: mainFile.length };
};
