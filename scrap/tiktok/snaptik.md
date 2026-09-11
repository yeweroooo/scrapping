# snaptik.js

TikTok downloader client and metadata scraper backed by the snaptik.app JSON
API. Single file, no dependencies, Node >= 18 (built-in `fetch` + WebCrypto).
Verified working 2026-09-11 against snaptik.app/en3 and its live JS bundle.

## Capabilities

| Post type | Outputs |
|---|---|
| Video | no-watermark MP4 (d.rapidcdn.app), original-quality HD MP4, MP3 audio, cover |
| Photo carousel | each slide (URL, dimensions, download link), MP3 audio, rendered MP4 of the carousel (convert.snapxcdn.com) |
| Both | exact stats (likes, comments, shares, plays, saves), author + follower stats, verified flag, caption, hashtags, mentions, create time, location, music (title, author, duration, play URL), video duration and dimensions |

## Usage

```bash
node snaptik.js "https://www.tiktok.com/@user/video/1234567890123456789"
node snaptik.js "https://www.tiktok.com/@user/photo/1234567890123456789" --download ./out
```

Prints one JSON object to stdout (an array when given several URLs). Exit code
is 0 when every URL succeeded. Logs go to stderr, so piping to `jq` or
`python3 -m json.tool` works.

### Options

- `--json` : compact single-line JSON (default is 2-space pretty)
- `--download [dir]` : save media to dir (default `./downloads`)
- `--delay SECONDS` : pause between URLs (rate limiting)
- `--no-enrich` : skip the TikTok metadata fetch
- `--no-hd` : skip the HD resolution request

### Module usage

```js
const { extract } = require('./snaptik.js');

const r = await extract('https://www.tiktok.com/@user/video/1234567890123456789');
console.log(r.downloads.video, r.stats, r.music.playUrl);
```

Exports: `extract`, `enrich`, `extractRaw`, `getToken`, `solveChallenge`,
`resolveHd`, `canonicalize`, `downloadTo`.

## The flow, in order

1. `POST https://snaptik.app/api/token` (header `X-Requested-With:
   XMLHttpRequest`) returns `{id, p}` where `p` is base64 of
   `iv || AES-256-CBC(puzzle JSON)`. The key is
   `SHA256("sn4pt1k_v3r1fy2026:" + id)`, the IV is the first 16 bytes.
2. Solve the puzzle (five types: `b`, `r`, `c`, `m`, `n`; see the code) and
   send the pass `"id:answer:_e:_h"` as the `X-Verify` header on
   `GET /api/extract?url=<tiktok url>`.
3. The extract response has `type` (`video` or `carousel`), `downloadUrl`
   (no-watermark MP4), `hdDownloadUrl` (a relative `/api/hd?token=...`
   path), `stats`, `author`, and `images[]` for carousels.
4. **HD**: `GET https://snaptik.app<hdDownloadUrl>` with a FRESH `X-Verify`
   pass plus `X-Requested-With` and a snaptik Referer returns
   `{"url": "<direct mp4>"}`. Without the fresh pass it answers 403.
5. **Metadata**: fetch the post page with an iPhone user agent (the desktop UA
   hits a WAF) and parse `<script id="api-data" type="application/json">`:
   `videoDetail.itemInfo.itemStruct`. This is the only source of the like
   count (diggCount), save count (collectCount), follower stats and the
   music `playUrl` (the MP3). Falls back to
   `__UNIVERSAL_DATA_FOR_REHYDRATION__` when `api-data` is absent.

## Token facts

- The `X-Verify` pass is a per-session challenge, not an API key. It carries
  a 300 second expiry (`_e`, unix seconds) and is reusable inside that
  window. This client solves a fresh one for every extract attempt and every
  HD call, so a stale or throttled pass is never reused.
- Limit-like failures (fresh 403s, rate/limit/expired messages) retry up to
  4 times with exponential backoff; each retry solves a new pass.

## Pitfalls handled

- `hdDownloadUrl` 403s without headers: send a fresh `X-Verify` plus
  `X-Requested-With: XMLHttpRequest` and a snaptik Referer.
- snaptik does not expose likes or an audio URL; both come from the TikTok
  `api-data` enrichment. `statsSource` records which backend each stat came
  from.
- Photo posts carry a stub `video` object with width/height 0: reported as
  null, not 0.
- In `api-data`, hashtags carry `textExtra.type: 1` (the legacy schema used
  `1` for mentions), so mentions are detected by the absence of `hashtagId`
  plus a `userId`/`userUniqueId`, not by the type code.
- TikTok's own `playAddr`/`downloadAddr` CDN URLs are IP and cookie bound and
  answer 403 outside the session that requested them. They are reported under
  `meta.sessionBound` instead of being presented as downloads.
- Slide dimensions come from `imagePost.images[].imageWidth/imageHeight`
  (camelCase), merged with snaptik's per-slide download links.

## Honest limits

- rapidcdn and tiktokcdn URLs carry expiring signatures (`x-expires`): treat
  them as short-lived and download soon after resolving.
- snaptik rate-limits per IP. Space batch runs with `--delay 3` or more.
- If you hit actual rate errors, the fix is fewer requests per minute or a
  different IP, not a fresh token: the pass is not the thing being counted.

For research and education only. Respect the terms of service of both sites.
