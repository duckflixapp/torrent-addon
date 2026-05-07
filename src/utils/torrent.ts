import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { AddonErrorFactory, DownloadProgress } from '@duckflixapp/addon-sdk';
import type { RqbitClient } from '../lib/rqbit';
import type { RqbitTorrent, TorrentStats } from '../torrent.types';

const defaultMaxSize = 1024 * 1024 * 2; // 2MB
const torrentCanceledCode = 'TORRENT_DOWNLOAD_CANCELED';

export const validateTorrentFileSize = async (torrentPath: string, maxSize: number = defaultMaxSize) => {
    const stats = await fs.stat(torrentPath);

    return stats.size < maxSize;
};

export const isTorrentCanceledError = (err: unknown) =>
    typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === torrentCanceledCode;

export class Torrent extends EventEmitter {
    private timeoutId: NodeJS.Timeout | null = null;
    private waitReject: ((reason?: unknown) => void) | null = null;

    constructor(
        private readonly client: TorrentClient,
        private readonly data: RqbitTorrent
    ) {
        super();
    }

    public get id() {
        return this.data.id;
    }

    public get infoHash() {
        return this.data.details.info_hash;
    }

    public get name() {
        return this.data.details.name;
    }

    public get outputFolder() {
        return this.data.output_folder;
    }

    public get files() {
        return this.data.details.files;
    }

    public async checkProgress(): Promise<{ stats: TorrentStats; progress: number }> {
        const stats = await this.client.stats(this.id);
        const progress = stats.total_bytes > 0 ? stats.progress_bytes / stats.total_bytes : 0;
        const peers = stats.live?.snapshot.peer_stats;

        this.emit('progress', {
            percent: Number((progress * 100).toFixed(2)),
            speed: stats.live?.download_speed.human_readable ?? '0 B/s',
            eta: stats.live?.time_remaining?.human_readable ?? 'N/A',
            peers: {
                active: peers?.live ?? 0,
                total: peers?.seen ?? 0,
                connecting: peers?.connecting ?? 0,
            },
        } as DownloadProgress);

        return { stats, progress };
    }

    public async waitDownload(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.timeoutId) {
                return reject(this.client.createError('Already waiting download for this torrent', { statusCode: 500 }));
            }
            this.waitReject = reject;

            let errorCount = 0;
            const timeout = async () => {
                try {
                    const { stats, progress } = await this.checkProgress().catch((err) => {
                        if (errorCount > 0) throw err;
                        this.emit('error', {
                            error: err,
                            code: 'PROGRESS_INTRV_CHECK',
                        });
                        return { stats: null, progress: 0 };
                    });
                    if (!stats) {
                        errorCount++;
                        this.timeoutId = setTimeout(timeout, 1000); // on check error
                        return;
                    }
                    errorCount = 0;

                    if (stats.finished || progress >= 1) {
                        this.stopTracking();
                        this.waitReject = null;
                        return resolve();
                    }

                    if (stats.state === 'error') {
                        this.stopTracking();
                        this.waitReject = null;
                        const error = stats.error ? new Error(stats.error) : undefined;
                        return reject(this.client.createError('rqbit reported a torrent error', { statusCode: 500, cause: error }));
                    }

                    this.timeoutId = setTimeout(timeout, 1000);
                } catch (err) {
                    this.stopTracking();
                    this.waitReject = null;
                    reject(this.client.createError('unexpected torrent error', { statusCode: 500, cause: err }));
                }
            };

            this.timeoutId = setTimeout(timeout, 1000);
        });
    }

    private stopTracking() {
        if (this.timeoutId) clearTimeout(this.timeoutId);
        this.timeoutId = null;
    }

    public async cancel() {
        const reject = this.waitReject;
        this.stopTracking();
        this.waitReject = null;
        this.removeAllListeners('progress');
        this.removeAllListeners('error');
        try {
            await this.client.remove(this.id);
        } catch (err) {
            reject?.(err);
            throw err;
        }
        reject?.(
            Object.assign(
                this.client.createError('Torrent download canceled', {
                    statusCode: 499,
                    details: { code: torrentCanceledCode },
                }),
                { code: torrentCanceledCode }
            )
        );
    }

    public async destroy() {
        await this.client.remove(this.id);
        this.stopTracking();
        this.waitReject = null;
        this.removeAllListeners('progress');
        this.removeAllListeners('error');
    }
}

export class TorrentClient {
    private readonly rqbit;
    private readonly error: AddonErrorFactory;

    constructor(options: { rqbit: RqbitClient; error: AddonErrorFactory }) {
        this.rqbit = options.rqbit;
        this.error = options.error;
    }

    public createError(...args: Parameters<AddonErrorFactory>) {
        return this.error(...args);
    }

    public async download(torrentFile: Buffer, options?: { outputFolder?: string; overwrite?: boolean }) {
        const data = await this.rqbit.torrentDownload(torrentFile, options);
        const torrent = new Torrent(this, data);
        return torrent;
    }

    public async remove(torrentId: number) {
        return this.rqbit.torrentDelete(torrentId);
    }

    public async stats(torrentId: number) {
        return this.rqbit.torrentStats(torrentId);
    }
}
