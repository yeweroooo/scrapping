# scrapping

TikTok downloader and metadata scraper collection. Zero-dependency Node
clients, one per downloader backend, plain HTTPS. No browser, no npm install.

| Script | Backend | Gate | Verified |
|---|---|---|---|
| [`scrap/snaptik.js`](scrap/snaptik.md) | snaptik.app JSON API | solvable AES challenge, `X-Verify` header | 2026-09-11 |
| [`scrap/sstik.js`](scrap/sstik.md) | ssstik.io conversion flow | form POST with htmx headers | 2026-09-11 |

## What these get you

For any TikTok post (video or photo carousel):

- **Video**: no-watermark MP4
- **Video HD**: original quality MP4
- **Audio**: MP3 of the post's sound, direct CDN link included
- **Photo carousel**: every slide image (URL, dimensions, download link),
  plus a rendered MP4 of the whole carousel
- **Metadata**: exact likes, comments, shares, plays, saves; author info,
  follower counts and verified flag; caption, hashtags, mentions, creation
  time; music title, author and play URL; video duration and dimensions

Metadata comes from the post page's own hydration JSON (`<script id="api-data">`),
so the counts are exact integers, not the rounded display values (33.7K) that
downloader sites show.

## Requirements

- Node.js >= 18 (uses the built-in `fetch`, no npm packages)

## Quick start

```bash
node scrap/snaptik.js "https://www.tiktok.com/@user/video/1234567890123456789"
node scrap/sstik.js   "https://www.tiktok.com/@user/video/1234567890123456789"
```

Both print the JSON result to stdout. Add `--download ./downloads` to save
media to disk, and `--delay N` to space out multi-URL runs (both backends
rate-limit per IP). Full flags per tool: [`scrap/snaptik.md`](scrap/snaptik.md),
[`scrap/sstik.md`](scrap/sstik.md).

## Project structure

```
scrapping/
├── README.md
└── scrap/
    ├── README.md        tools index
    ├── snaptik.md       snaptik.app client docs
    ├── snaptik.js       the snaptik.app scraper
    ├── sstik.md         ssstik.io client docs
    └── sstik.js         the ssstik.io scraper
```

## How it works (short version)

- **snaptik.app**: `POST /api/token` returns an AES-256-CBC puzzle. Decrypt it
  with the secret embedded in their bundle, solve it, send the result as
  `X-Verify`, then read `GET /api/extract?url=...`. HD is one more request to
  `/api/hd?token=...` with a fresh pass. Details in `scrap/snaptik.md`.
- **ssstik.io**: `GET /` for the `s_tt` token, `POST /abc?url=dl` with the
  `HX-*` headers, follow `hx-redirect` for HD, decode the base64
  `slides_data` input for carousels. Details in `scrap/sstik.md`.

Both then enrich from TikTok itself: fetch the post page with an iPhone user
agent (the desktop UA gets a WAF) and parse the `api-data` JSON for exact
counts, author stats and the music URL.

This is a research/educational project. Respect TikTok's and the downloader
sites' terms of service, and don't hammer either service: both rate-limit
aggressively.
