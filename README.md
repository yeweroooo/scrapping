# scrapping

A collection of scrapers for various data sources. Zero-dependency Node
clients over plain HTTPS. No browser in the normal path, no npm install; the
only exception is an optional browser fallback for the Instagram client, used
when a backend challenges the HTTP client.

| Source | Directory | Tools | Verified |
|---|---|---|---|
| TikTok | [`scrap/tiktok/`](scrap/tiktok/) | [`snaptik.js`](scrap/tiktok/snaptik.js) (snaptik.app JSON API), [`sstik.js`](scrap/tiktok/sstik.js) (ssstik.io flow) | 2026-09-11 |
| Spotify | [`scrap/spotify/`](scrap/spotify/) | [`spotidown.js`](scrap/spotify/spotidown.js) (spotidown.app flow) | 2026-09-11 |
| Instagram | [`scrap/instagram/`](scrap/instagram/) | [`igdownload.js`](scrap/instagram/igdownload.js) (fastdl.app worker hub, signed API over HTTP/2) | 2026-09-11 |

New sources land under `scrap/<source>/` as they are built. The layout and the
rules every client follows are documented in [`scrap/README.md`](scrap/README.md).

## What the Spotify tool does

For any Spotify track, album, playlist or search: the MP3 the site serves plus
the HD cover, and per-track metadata (title, artist, album, duration, release
year, Spotify track id, cover URL) for every track in the collection.
Capabilities, output shape and the measured quality caveat live in
[`scrap/spotify/README.md`](scrap/spotify/README.md).

## What the Instagram tool does

For any Instagram post, reel, IGTV link, carousel, story or profile: every media
item the downloader exposes (video renditions, slide images, thumbnails, the
post's audio track), with the direct CDN URL decoded out of the proxy link, plus
author, caption, likes, comments, views, taken time, the reel's soundtrack and
the DASH manifest split into video and audio renditions. Profile mode adds
followers, the post feed with cursors, stories and highlights. Capabilities,
output shape and the transport-gate story live in
[`scrap/instagram/README.md`](scrap/instagram/README.md).

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
node scrap/spotify/spotidown.js "https://open.spotify.com/album/6QdCohkHKNTVoaSx1ZzitH" --download ./out
node scrap/instagram/igdownload.js "https://www.instagram.com/reel/DO5tIDME6t-/"
node scrap/instagram/igdownload.js gazdaviesmedia --pages 2 --json
```

JSON goes to stdout, logs to stderr.

## Project structure

```
scrapping/
├── README.md
└── scrap/
    ├── README.md            collection index and conventions
    ├── tiktok/              one directory per data source
    │   ├── README.md        which client to use, output shape
    │   ├── snaptik.js       snaptik.app client
    │   ├── snaptik.md       snaptik.app docs: flow, tokens, limits
    │   ├── sstik.js         ssstik.io client
    │   └── sstik.md         ssstik.io docs: flow, pitfalls, limits
    ├── spotify/
    │   ├── README.md        what you get, quality caveat, limits
    │   ├── spotidown.js     spotidown.app client
    │   └── spotidown.md     spotidown.app docs: flow, gate, pitfalls
    └── instagram/
        ├── README.md        what you get, output shape, limits
        ├── igdownload.js    fastdl.app client (signed API over HTTP/2)
        ├── igdownload.md    fastdl.app docs: signature, transport gate, pitfalls
        ├── verify_igdownload.js  16-check test report
        └── solver/          optional browser fallback: Turnstile token, mirror mode
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

- **fastdl.app**: the worker hub wants an HMAC-signed body
  (`_s` = HMAC-SHA256 of the sorted JSON plus `ts`), and it answers the
  Turnstile challenge to HTTP/1.1 clients only, so the client speaks HTTP/2. An
  optional browser fallback mints a Turnstile token or replays the request from
  inside the page. Details in
  [`scrap/instagram/igdownload.md`](scrap/instagram/igdownload.md).

- **spotidown.app**: `GET /en7` for the session cookie and a hidden anti-bot
  field whose name rotates per page load, `POST /action` (a `g-recaptcha-response`
  value is checked for presence only, never verified), `POST /action/track` for
  the signed MP3 and cover links, then download those with the session cookie.
  Details in [`scrap/spotify/spotidown.md`](scrap/spotify/spotidown.md).

This is a research and education project. Respect each site's and each
platform's terms of service, and do not hammer the backends: the downloader
sites rate-limit per IP.
