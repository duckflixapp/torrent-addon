import { SDK, videoProcessor } from '@duckflixapp/addon-sdk';
import type {
    AddonErrorFactory,
    PreparedVideoProcessorSource,
    RawVideoProcessorSource,
    VideoProcessorContext,
    VideoProcessorScanInput,
    VideoProcessorScanItem,
    VideoProcessorStartOutput,
} from '@duckflixapp/addon-sdk';
import { processTorrentFileWorkflow, scanTorrentFileWorkflow } from './workflow';

type PreparedFileVideoProcessorSource = Extract<PreparedVideoProcessorSource, { sourceType: 'file' }>;

function validateTorrentSource(
    source: RawVideoProcessorSource | PreparedVideoProcessorSource,
    error: AddonErrorFactory
): asserts source is PreparedFileVideoProcessorSource {
    if (source.sourceType !== 'file') {
        throw error('Torrent processor only supports .torrent file sources', { statusCode: 400 });
    }

    if (source.file.size > 5 * 1024 * 1024) {
        throw error('Torrent file is suspiciously large', { statusCode: 400 });
    }

    const isTorrentMime = source.file.type === 'application/x-bittorrent';
    const isTorrentExt = source.file.name.toLowerCase().endsWith('.torrent');

    if (!isTorrentMime && !isTorrentExt) {
        throw error('The "torrent" field must contain a .torrent file.', { statusCode: 400 });
    }
}

export const sdk = new SDK({
    id: 'torrent-addon',
    name: 'Torrent Addon',
    version: '0.1.0',
    runtime: 'bun',
    entry: 'index.js',
    description: 'Duckflix torrent video processor addon.',
    permissions: ['network', 'filesystem:job', 'p2p'],
    capabilities: [
        {
            kind: 'video.processor',
            processor: {
                id: 'torrent',
                initialStatus: 'downloading',
                sourceTypes: ['file'],
            },
        },
    ],
});

export const torrentProcessor = videoProcessor({
    validateSource(source, context): Promise<void> | void {
        if (source.sourceType !== 'file') {
            throw context.error('Torrent processor only supports .torrent file sources', { statusCode: 400 });
        }

        if (source.file.size > 5 * 1024 * 1024) {
            throw context.error('Torrent file is suspiciously large', { statusCode: 400 });
        }

        const isTorrentMime = source.file.type === 'application/x-bittorrent';
        const isTorrentExt = source.file.name.toLowerCase().endsWith('.torrent');

        if (!isTorrentMime && !isTorrentExt) {
            throw context.error('The "torrent" field must contain a .torrent file.', { statusCode: 400 });
        }
    },

    scan: async (
        { source, dbUrl, requestedType }: VideoProcessorScanInput,
        context: VideoProcessorContext
    ): Promise<VideoProcessorScanItem[]> => {
        const error = context.error.bind(context);
        validateTorrentSource(source, error);

        const scan = await scanTorrentFileWorkflow({ torrentPath: source.tempPath }, context);

        return scan.files.map((file) => ({
            id: `torrent:${scan.infoHash}:${file.torrentIndex}`,
            source,
            requestedType: requestedType,
            title: file.name || scan.name,
            metadata: null,
        }));
    },

    start: async ({ source, items }, context): Promise<VideoProcessorStartOutput> => {
        const error = context.error.bind(context);
        validateTorrentSource(source, error);

        const videos = await processTorrentFileWorkflow({ torrentPath: source.tempPath, items }, context);

        return videos;
    },
});

export default sdk.createModule({
    capabilities: {
        'video.processor': torrentProcessor,
    },
});
