import { SDK, videoProcessor } from '@duckflixapp/addon-sdk';
import type { VideoProcessorStartOutput } from '@duckflixapp/addon-sdk';
import { AppError } from './torrent.errors';
import { processTorrentFileWorkflow } from './workflow';

const sdk = new SDK({
    capabilities: ['video.processor'] as const,
});

export const torrentProcessor = videoProcessor({
    validateSource(source): Promise<void> | void {
        if (source.sourceType !== 'file') {
            throw new AppError('Torrent processor only supports .torrent file sources', { statusCode: 400 });
        }

        if (source.file.size > 5 * 1024 * 1024) {
            throw new AppError('Torrent file is suspiciously large', { statusCode: 400 });
        }

        const isTorrentMime = source.file.type === 'application/x-bittorrent';
        const isTorrentExt = source.file.name.toLowerCase().endsWith('.torrent');

        if (!isTorrentMime && !isTorrentExt) {
            throw new AppError('The "torrent" field must contain a .torrent file.', { statusCode: 400 });
        }
    },

    async identify({ source }) {
        if (source.sourceType !== 'file') return null;

        return null;
    },

    start: async ({ source }, context): Promise<VideoProcessorStartOutput> => {
        if (source.sourceType !== 'file') {
            throw new AppError('Torrent processor only supports .torrent file sources', { statusCode: 400 });
        }

        const { name, path, size } = await processTorrentFileWorkflow({ torrentPath: source.tempPath }, context);

        return { fileName: name, fileSize: size, path };
    },
});

export default sdk.createModule({
    capabilities: {
        'video.processor': torrentProcessor,
    },
});
