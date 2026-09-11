# sstik.js (ssstik.io)

TikTok downloader client and metadata scraper. Single file, no dependencies,
Node >= 18 (built-in `fetch`).

Backed by the ssstik.io conversion flow plus TikTok's own page data for exact
metadata. Verified working 2026-09-11.

## Capabilities

| Post type | Outputs |
|---|---|
| Video | no-watermark MP4, original-quality HD MP4, MP3 audio, cover image |
| Photo carousel | each slide (metadata + download link), MP3 audio, rendered MP4 of the carousel |
| Both | exact stats (likes, comments, shares, plays, saves), author + follower stats, caption, hashtags, create time, music (title, author, play URL), video duration and dimensions |

## Usage

```bash
node sstik.js "https://www.tiktok.com/@user/video/1234567890123456789"
node sstik.js "https://www.tiktok.com/@user/photo/1234567890123456789" --download ./out
```

Always prints JSON to stdout. Exit code is 0 when every URL succeeded.

### Options

- `--download [dir]` : save media to dir (default `./downloads`)
- `--locale en` : downloader UI locale
- `--delay SECONDS` : pause between URLs (rate limiting)
- `--no-enrich` : skip the TikTok metadata fetch
- `--no-hd` : skip the HD resolution request
- `--json` : no-op, kept for compatibility

### Module usage

```js
const { extract } = require('./sstik.js');

const r = await extract('https://www.tiktok.com/@user/video/1234567890123456789');
console.log(r.downloads.hd, r.meta.detail.stats);
```

Exports: `extract`, `enrich`, `submit`, `getToken`, `resolveHd`,
`slidesAsVideo`, `decodeTikcdn`, `downloadTo`.

## The flow, in order

1. `GET https://ssstik.io/`, grab `s_tt` from the page JS.
2. `POST /abc?url=dl` with form `{id, locale, tt}` and headers
   `HX-Request: true`, `HX-Target: target`, `Origin`, `Referer`. The response
   header `hx-trigger` tells the type: `ssssuccess_videoandmp3`,
   `ssssuccess_slides`, `ssslimitexceed` (rate limit), `sssinvalidlink`.
   Invalid links show up as `images/rickrolled.gif` in the body.
3. **HD**: the result HTML has `id="hd_download" data-directurl="/abc?url=..."`.
   POST that path with body `tt=<fresh tt>`; the `hx-redirect` response header
   is the original-quality tikcdn URL.
4. **Slides**: the `slides_data` hidden input holds base64 JSON with each slide
   URL and size. The `#slides_generate` button POSTs that payload to
   `https://r.ssstik.top/b/index.sh` and gets an MP4 URL in `hx-redirect`.
5. **Metadata**: fetch the post page with an iPhone user agent (the desktop UA
   gets a Slardar WAF on `/video/` URLs) and parse
   `<script id="api-data" type="application/json">`:
   `videoDetail.itemInfo.itemStruct`. Falls back to
   `__UNIVERSAL_DATA_FOR_REHYDRATION__` if `api-data` is absent.

## Pitfalls handled

- Attributes in the result HTML are tab-separated, not space-separated
  (`name="tt"\tvalue="..."`); all parsing uses `\s+`.
- tikcdn.io serves slides as `application/octet-stream` with no extension;
  files are sniffed from magic bytes (WEBP, JPEG, PNG, MP4, MP3).
- `ssslimitexceed` and connection resets are retried with exponential backoff
  (4 attempts); a bad URL never recovers, so it fails fast.
- Desktop UA on TikTok = WAF challenge page; iPhone UA returns the full
  `api-data` JSON for both video and photo posts.

## Honest limits

- tikcdn.io links expire (the `e=` parameter, usually hours) and are
  IP-bound. Treat them as short-lived.
- `r1.ssstik.top` (slides-as-video host) has flaky DNS; the request succeeds
  sometimes and fails other times.
- Downloader sites display rounded counts; use the `meta.detail.stats` block
  for exact numbers.

For research and education only. Respect the terms of service of both sites.
