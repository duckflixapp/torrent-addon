import axios from 'axios';
import type { AddonErrorFactory } from '@duckflixapp/addon-sdk';
import type { RqbitTorrent, TorrentStats } from '../torrent.types';

export class RqbitClient {
    private readonly api;
    private readonly error: AddonErrorFactory;

    constructor(options: { baseUrl?: string; error: AddonErrorFactory }) {
        const baseUrl = options?.baseUrl ?? 'http://localhost:3030';
        this.error = options.error;
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
                throw this.error('Torrent not added.', {
                    statusCode,
                    cause: err,
                    details: {
                        responseData,
                    },
                });
            });
        return torrent;
    }

    public async torrentDelete(torrentId: number): Promise<void> {
        await this.api.post(`/torrents/${torrentId}/delete`).catch((err) => {
            const statusCode = axios.isAxiosError(err) ? (err.response?.status ?? 500) : 500;
            throw this.error('Torrent not removed.', { statusCode, cause: err });
        });
    }

    public async torrentStats(torrentId: number): Promise<TorrentStats> {
        const { data: stats } = await this.api.get<TorrentStats>(`/torrents/${torrentId}/stats/v1`).catch((err) => {
            const statusCode = axios.isAxiosError(err) ? (err.response?.status ?? 500) : 500;
            throw this.error('Torrent stats not retrieved.', { statusCode, cause: err });
        });
        return stats;
    }
}
