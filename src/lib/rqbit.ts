import axios from 'axios';
import type { RqbitTorrent, TorrentStats } from '../torrent.types';
import { AppError } from '../torrent.errors';

export class RqbitNewTorrentError extends AppError {
    constructor(code: number, cause?: unknown, details?: Record<string, unknown>) {
        super('Torrent not added.', { statusCode: code, cause, details });
    }
}

export class RqbitStatsError extends AppError {
    constructor(code: number) {
        super('Torrent stats not retrieved.', { statusCode: code });
    }
}

export class RqbitRemoveError extends AppError {
    constructor(code: number) {
        super('Torrent stats not retrieved.', { statusCode: code });
    }
}

export class RqbitClient {
    private readonly api;
    constructor(options?: { baseUrl?: string }) {
        const baseUrl = options?.baseUrl ?? 'http://localhost:3030';
        this.api = axios.create({ baseURL: baseUrl, responseType: 'json' });
    }

    public async torrentDownload(torrentFile: Buffer, options?: { outputFolder?: string }): Promise<RqbitTorrent> {
        const { data: torrent } = await this.api
            .post<RqbitTorrent>(`/torrents`, torrentFile, {
                params: { overwrite: true, output_folder: options?.outputFolder },
                headers: { 'Content-Type': 'application/x-bittorrent' },
            })
            .catch((err) => {
                const statusCode = axios.isAxiosError(err) ? (err.response?.status ?? 500) : 500;
                const responseData = axios.isAxiosError(err) ? err.response?.data : undefined;
                throw new RqbitNewTorrentError(statusCode, err, {
                    responseData,
                });
            });
        return torrent;
    }

    public async torrentDelete(torrentId: number): Promise<void> {
        await this.api.post(`/torrents/${torrentId}/delete`).catch((err) => {
            const statusCode = err.response?.status ?? 500;
            throw new RqbitRemoveError(statusCode);
        });
    }

    public async torrentStats(torrentId: number): Promise<TorrentStats> {
        const { data: stats } = await this.api.get<TorrentStats>(`/torrents/${torrentId}/stats/v1`).catch((err) => {
            const statusCode = err.response?.status ?? 500;
            throw new RqbitStatsError(statusCode);
        });
        return stats;
    }
}
