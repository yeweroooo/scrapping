# scrapping

TikTok downloader and metadata scraper collection. One script, no dependencies, plain HTTPS.

The first tool lives in [`scrap/`](scrap/): `sstik.js`, a Node client for the
ssstik.io downloader flow that also pulls exact post metadata from TikTok's own
page data.

## What it gets you

For any TikTok post (video or photo carousel):

- **Video**: no-watermark MP4 (ssstik.io resolution)
- **Video HD**: original quality MP4 (ssstik.io `hx-redirect` flow)
- **Audio**: MP3 of the post's sound, direct CDN link included
- **Photo carousel**: every slide image (metadata + per-slide download links),
  plus a rendered MP4 of the whole carousel
- **Metadata**: exact likes, comments, shares, plays, saves; author info and
  follower counts; caption, hashtags, creation time; music title, author and
  play URL; video duration and dimensions

Metadata comes from the post page's own hydration JSON (`<script id="api-data">`),
so the counts are exact integers, not the rounded display values (33.7K) that
downloader sites show.

## Requirements

- Node.js >= 18 (uses the built-in `fetch`, no npm packages)

## Quick start

```bash
node scrap/sstik.js "https://www.tiktok.com/@user/video/1234567890123456789"
```

Prints the JSON result to stdout:

```bash
node scrap/sstik.js <url> --download ./downloads
```

Also saves video, HD, MP3 and slides to disk.

Multiple URLs in one run are supported; space them out with `--delay` because
ssstik.io rate-limits per IP.

### Options

```
node scrap/sstik.js <url> [<url2> ...]
  --json              (accepted for compatibility; JSON is printed by default)
  --download [dir]    save media to dir (default: ./downloads)
  --locale en         downloader UI locale (default: en)
  --delay SECONDS     pause between URLs (default: 0)
  --no-enrich         skip the TikTok metadata fetch (faster, less data)
  --no-hd             skip the HD resolution request
```

## JSON output shape

```json
{
  "type": "video" | "slides",
  "source": "https://www.tiktok.com/...",
  "downloads": {
    "video": "https://tikcdn.io/...",
    "hd": "https://tikcdn.io/...",
    "audio": "https://tikcdn.io/...",
    "slides": [ { "url": "...", "downloadUrl": "...", "width": 1200, "height": 1500 } ],
    "slidesAsVideo": "https://r1.ssstik.top/dev.ssstik/<item_id>",
    "cover": "https://tikcdn.io/..."
  },
  "meta": {
    "author": "...",
    "caption": "...",
    "counts": { "likes": "...", "comments": "...", "shares": "..." },
    "detail": {
      "id": "...", "desc": "...", "createTime": "...",
      "stats": { "likes": 33700, "comments": 325, "shares": 3426, "plays": 366800, "saves": 1807 },
      "author": { "uniqueId": "...", "nickname": "...", "signature": "...", "avatar": "..." },
      "authorStats": { "followers": 766400, "following": 997, "likes": 17900000, "videos": 507 },
      "music": { "id": "...", "title": "...", "author": "...", "duration": 17, "playUrl": "..." },
      "video": { "duration": 15, "width": 540, "height": 960, "cover": "...", "playUrl": "...", "downloadUrl": "..." },
      "hashtags": ["..."]
    }
  },
  "saved": { "video": { "path": "...", "bytes": 2131629 } }
}
```

Decoded CDN URLs are included too (`videoDirect`, `hdDirect`, `audioDirect`,
`coverDirect`, per-slide `directUrl`), unwrapped from the tikcdn.io base64
payloads. Note the tikcdn links are short-lived and IP-bound; the decoded ones
may expire sooner.

## Project structure

```
scrapping/
├── README.md
└── scrap/
    ├── README.md      tool documentation
    └── sstik.js       the scraper (single file, zero deps)
```

## How it works (short version)

1. `GET https://ssstik.io/` extracts the `s_tt` token from the page.
2. `POST /abc?url=dl` with `{id, locale, tt}` and the `HX-*` headers returns
   the result HTML; the `hx-trigger` response header says video or slides.
3. HD: re-POST the `data-directurl` path with a fresh `tt`; the
   `hx-redirect` header carries the original-quality URL.
4. Slides: decode the base64 `slides_data` input; the `#slides_generate`
   endpoint renders them into an MP4.
5. Metadata: fetch the TikTok post page with an iPhone user agent (the desktop
   UA hits a WAF on video pages) and parse the `api-data` hydration JSON.

This is a research/educational project. Respect TikTok's and ssstik.io's terms
of service, and don't hammer either service: both rate-limit aggressively.
