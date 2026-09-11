# scrapping

A collection of scrapers for various data sources. Zero-dependency Node
clients, plain HTTPS. No browser automation, no npm install.

| Source | Directory | Tools | Verified |
|---|---|---|---|
| TikTok | [`scrap/tiktok/`](scrap/tiktok/) | [`snaptik.js`](scrap/tiktok/snaptik.js) (snaptik.app JSON API), [`sstik.js`](scrap/tiktok/sstik.js) (ssstik.io flow) | 2026-09-11 |

New sources land under `scrap/<source>/` as they are built. The layout and the
rules every client follows are documented in [`scrap/README.md`](scrap/README.md).

## What the TikTok tools do

For any TikTok post, video or photo carousel: no-watermark MP4, original
quality HD MP4, MP3 audio, every carousel slide plus a rendered MP4 of the
carousel, and exact stats (likes, comments, shares, plays, saves) with author,
music and caption metadata. Capabilities, output shape and client comparison
live in [`scrap/tiktok/README.md`](scrap/tiktok/README.md).

## Requirements

- Node.js >= 18 (uses the built-in `fetch`, no packages)

## Quick start

```bash
node scrap/tiktok/snaptik.js "https://www.tiktok.com/@user/video/1234567890123456789"
node scrap/tiktok/snaptik.js "https://www.tiktok.com/@user/photo/1234567890123456789" --download ./out
node scrap/tiktok/sstik.js   "https://www.tiktok.com/@user/video/1234567890123456789" --delay 3
```

JSON goes to stdout, logs to stderr.

## Project structure

```
scrapping/
├── README.md
└── scrap/
    ├── README.md            collection index and conventions
    └── tiktok/              one directory per data source
        ├── README.md        which client to use, output shape
        ├── snaptik.js       snaptik.app client
        ├── snaptik.md       snaptik.app docs: flow, tokens, limits
        ├── sstik.js         ssstik.io client
        └── sstik.md         ssstik.io docs: flow, pitfalls, limits
```

## How it works (short version)

- **snaptik.app**: `POST /api/token` returns an AES-256-CBC puzzle. Decrypt it
  with the secret embedded in their bundle, solve it, send the result as
  `X-Verify`, then read `GET /api/extract?url=...`. HD is one more request to
  `/api/hd?token=...` with a fresh pass. Details in
  [`scrap/tiktok/snaptik.md`](scrap/tiktok/snaptik.md).
- **ssstik.io**: `GET /` for the `s_tt` token, `POST /abc?url=dl` with the
  `HX-*` headers, follow `hx-redirect` for HD, decode the base64
  `slides_data` input for carousels. Details in
  [`scrap/tiktok/sstik.md`](scrap/tiktok/sstik.md).
- **Enrichment (both)**: fetch the post page with an iPhone user agent (the
  desktop UA gets a WAF) and parse the `api-data` JSON for exact counts,
  author stats and the music URL.

This is a research and education project. Respect TikTok's and the downloader
sites' terms of service, and do not hammer either service: both rate-limit
per IP.
