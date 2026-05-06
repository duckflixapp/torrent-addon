export class AppError extends Error {
    public readonly originalError?: unknown;
    public readonly statusCode?: number;
    public readonly headers?: Record<string, string>;
    public readonly details?: Record<string, unknown>;

    constructor(
        public override message: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options?: { cause?: any; statusCode?: number; headers?: Record<string, string>; details?: Record<string, unknown> }
    ) {
        super(message);
        this.name = 'AppError';
        this.statusCode = options?.statusCode;
        this.originalError = options?.cause;
        this.headers = options?.headers;
        this.details = options?.details;
        if (options?.cause?.stack) {
            this.stack += `\nCAUSED BY: ${options.cause.stack}`;
        }
    }
}

export class TorrentDownloadError extends AppError {
    constructor(cause: { message?: string; code?: string }) {
        let friendlyMessage = 'Torrent could not be downloaded';
        if (cause?.message?.includes('no peers')) friendlyMessage = 'No active seeders found for this torrent.';
        if (cause?.code === 'ENOSPC') friendlyMessage = 'Not enough disk space for download.';

        super(friendlyMessage, { cause, statusCode: 400 });
    }
}
