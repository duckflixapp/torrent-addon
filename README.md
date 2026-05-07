# Duckflix Torrent Addon

Torrent video processor addon for Duckflix.

## Install

1. Download the latest `torrent-addon-*.zip` from GitHub Releases.
2. Unzip it.
3. Move the extracted `torrent-addon` folder into your Duckflix addons folder.
4. Restart Duckflix.

The addon folder should look like this:

```txt
torrent-addon/
  index.js
  manifest.json
```

## Requirements

This addon expects an rqbit server to be running.

By default it connects to:

```txt
http://localhost:3030
```

You can override that with:

```bash
RQBIT_URL=http://your-rqbit-host:3030
```

## Development

Install dependencies:

```bash
bun install
```

Typecheck:

```bash
bun run typecheck
```

Build the addon:

```bash
bun run build
```

Create a local release zip:

```bash
bun run pack
```

The generated zip will be available at:

```txt
release/torrent-addon.zip
```

## Release

Push a version tag to create a GitHub Release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The release workflow builds the addon, packages `dist/index.js` and `dist/manifest.json`, and uploads the zip to the GitHub Release.
