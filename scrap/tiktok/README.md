# TikTok

TikTok downloader and metadata scrapers. Two clients, two backends. Both
verified working 2026-09-11.

| Client | Backend | Gate | Docs |
|---|---|---|---|
| [`snaptik.js`](snaptik.js) | snaptik.app JSON API (preferred) | solvable AES challenge sent as the `X-Verify` header | [snaptik.md](snaptik.md) |
| [`sstik.js`](sstik.js) | ssstik.io conversion flow | form POST with htmx headers | [sstik.md](sstik.md) |

## Which one to use

Prefer `snaptik.js`: its gate is a solvable client-side challenge, so a single
file of plain HTTP requests is enough, and the video links come straight from
d.rapidcdn.app. Fall back to `sstik.js` when snaptik is rate-limiting your IP,
or when you specifically want the tikcdn.io CDN URLs.

## What you get

| Post type | Outputs |
|---|---|
| Video | no-watermark MP4, original-quality HD MP4, MP3 audio, cover image |
| Photo carousel | each slide (URL, dimensions, download link), MP3 audio, rendered MP4 of the carousel |
| Both | exact stats (likes, comments, shares, plays, saves), author + follower stats, verified flag, caption, hashtags, mentions, create time, music (title, author, duration, play URL), video duration and dimensions |

Metadata comes from the post page's own hydration JSON (`<script id="api-data">`),
so counts are exact integers, not the rounded display values (33.7K) that
downloader sites show.

## Quick start

```bash
node snaptik.js "https://www.tiktok.com/@user/video/1234567890123456789"
node snaptik.js "https://www.tiktok.com/@user/photo/1234567890123456789" --download ./out
node sstik.js   "https://www.tiktok.com/@user/video/1234567890123456789" --delay 3
```

Both print JSON to stdout and logs to stderr, so `| jq` and
`| python3 -m json.tool` work. Exit code is 0 when every URL succeeded.

## Output shape

The `downloads` block has the same fields in both clients:

| Field | Meaning |
|---|---|
| `video` | no-watermark MP4 |
| `hd` | original-quality MP4 (resolved, direct link) |
| `hdEndpoint` | the intermediate `/api/hd?token=...` path (snaptik only) |
| `audio` | MP3 of the post's sound |
| `cover` | poster image |
| `slides[]` | carousel images (`url`, `width`, `height`, `downloadUrl`) |
| `slidesAsVideo` | rendered MP4 of a photo carousel |

Metadata is laid out differently, so map it explicitly when you consume both:

| Value | `snaptik.js` | `sstik.js` |
|---|---|---|
| stats | `stats` | `meta.detail.stats` |
| author | `author` + `author.stats` | `meta.detail.author` + `meta.detail.authorStats` |
| music | `music` | `meta.detail.music` |
| video | `video` | `meta.detail.video` |
| description | `meta.description` | `meta.detail.desc` |

`snaptik.js` also reports `statsSource`, which names the backend each stat came
from, and `meta.sessionBound` for TikTok URLs that only work from the session
that requested them.

## Shared behaviours

- iPhone user agent for the TikTok metadata fetch (the desktop UA gets a WAF)
- Rate-limit style failures retried with exponential backoff
- CDN links carry expiring signatures: download soon after resolving
- `--delay SECONDS` to space out batch runs, since both backends rate-limit per IP
