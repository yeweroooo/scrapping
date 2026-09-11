# igdownload.js

Instagram downloader client and metadata scraper backed by fastdl.app.
Single file, no dependencies, Node >= 18 (`fetch`, `node:http2`, `node:https`).
Verified working 2026-09-11 against the live worker hub.

## Capabilities

| Input | Outputs |
|---|---|
| `instagram.com/reel/<code>/` | video renditions, thumbnail, the reel's audio track |
| `instagram.com/p/<code>/` (photo or carousel) | one media entry per slide, in slide order |
| `instagram.com/tv/<code>/` | video renditions plus thumbnail |
| `instagram.com/stories/<user>/<id>/` | story media (falls back to the post route) |
| `instagram.com/<user>/` or bare `username` | profile stats, post feed, stories, highlights |
| All | author, caption, likes, comments, views, taken time, shortcode, soundtrack, DASH manifest split into video and audio renditions |

Beyond what the downloader's page shows, the client decodes the direct CDN URL
out of every proxy link and reports the resolved numbers: slide counts per
carousel, resolution per rendition, byte sizes, and exact counts from the API
rather than the rounded values on the page.

## Usage

```bash
node igdownload.js "https://www.instagram.com/reel/DO5tIDME6t-/"
node igdownload.js "https://www.instagram.com/p/DEc1QSlIdb_/" --download ./out
node igdownload.js gazdaviesmedia --pages 2
node igdownload.js "<url1>" "<url2>" --json
```

Prints one JSON object to stdout (an array when given several inputs). Exit code
is 0 when every input succeeded. Logs go to stderr, so piping to `jq` or
`python3 -m json.tool` works.

### Options

- `--json` : compact single-line JSON (default is 2-space pretty); `--compact` still works
- `--out FILE` : also write the JSON to FILE
- `--download [dir]` : save every media item (default `./downloads`), direct CDN first
- `--delay SECONDS` : pause between inputs (default 1)
- `--raw` : add the untouched API payload under `raw`
- `--pages N` : profile mode, how many post pages to walk (12 posts per page)
- `--all-versions` : keep every Instagram image size instead of only the largest
- `--timeout MS` : per-request budget (default 30000)
- `--token T` / `--turnstile T` : drop in a `wh-cf-token`, or a Turnstile token the client exchanges at `POST /api/cf`
- `--no-solve` / `--no-browser` : disable the two browser fallbacks
- `--h1` : force HTTP/1.1, which raises the challenge on purpose (useful to test the fallbacks)
- `--solve-timeout MS` : how long the browser may take
- `--refresh-key` / `--key HEX` : re-derive or override the request signing key

### Module usage

```js
const ig = require('./igdownload.js');

const res = await ig.api('/api/convert', { target_url: 'https://www.instagram.com/reel/DO5tIDME6t-/' }, { solve: false });
const out = { ok: true, ...ig.normalizeConvert(res.json, ig.parseInput('https://www.instagram.com/reel/DO5tIDME6t-/')) };
console.log(out.author.username, out.media.map((m) => [m.kind, m.label]));
```

Exports: `api`, `signBody`, `stableStringify`, `parseInput`, `normalizeConvert`,
`normalizePostNode`, `normalizeUser`, `normalizePostsPayload`,
`normalizeStoriesPayload`, `normalizeHighlightsPayload`, `parseDashManifest`,
`mediaEntry`, `collectDownloads`, `downloadAll`, `errorReport`, `http2Post`,
`browserFetch`, `refreshKey`, `solveCaptcha`, `KEY_HEX`,
`DEFAULT_TURNSTILE_SITEKEY`.

## The flow, in order

1. `POST https://api-wh.fastdl.app/api/convert` with a signed body
   `{target_url}` returns the media list, `meta` and `thumb`. Carousels return
   an **array** with one entry of that shape per slide.
2. Profile input instead goes to the worker hub's Instagram routes:
   `userInfo {username}` -> `result[0].user`, `posts {username, maxId}` ->
   `result.edges[].node` (the full GraphQL media node), `stories {username}` and
   `highlights {userId}`.
3. Pagination is cursor based: the next call sends the previous
   `result.page_info.end_cursor` as `maxId`, and `has_next_page` says whether to
   continue (the string `"None"` means stop).
4. `media.fastdl.app/get?__sig=..&__expires=..&uri=<urlencoded CDN url>` links
   carry the real CDN URL in `uri`; the client decodes it instead of scraping
   the page. Direct CDN URLs are tried first when downloading, the signed proxy
   is the fallback.

## The request signature

Unsigned requests answer
`401 REQUEST_SIGNATURE_MISSING_REQUIRED_PARAMETERS`, and their landing-page
`js/app.js` is not where the logic lives: the signer sits in webpack chunk 54
(`js/link.chunk.js?ch=<hash>`, the hash is in the app.js chunk map), module 7027
inside an obfuscated bundle (LZString-packed string table, name collisions).

Signed body = the original body plus:

```
ts   = Date.now()
_ts  = 1788421776280      constant the site always sends
_tsc = 0                  clock-skew correction
_sv  = 2                  signature version
_s   = HMAC_SHA256(key, JSON.stringify(body with top-level keys sorted) + ts)  (lowercase hex)
```

The key is a 32-byte constant recovered from that chunk
(`6632138f3b8f4f0ac4bba56d338f913fdfd5481947c9d20ca7b557b96bce7574`) but it is
derived from a blob in the bundle, so a redeploy can rotate it. `refreshKey()`
handles that: it runs fastdl.app's own chunk in a `vm` sandbox with a Proxy
global, takes module 7027's default export (a promise for the signer), and reads
the key bytes out of a wrapped `crypto.subtle.importKey`. The CLI calls it
automatically on a 401 and caches the result in `~/.cache/igdownload.json`.

## The transport gate

The hub answers HTTP 422 `CAPTCHA_REQUIRED` (Turnstile, siteKey
`0x4AAAAAABhLwGG2XCb7fE2M`) to **HTTP/1.1** clients that are not a browser, and
serves the identical signed request over **HTTP/2**. Measured from one
datacenter IP:

| client | result |
|---|---|
| `fetch()` / undici (HTTP/1.1) | 422 CAPTCHA_REQUIRED |
| `node:http2` POST, same path and headers | 200 with the real JSON |
| curl HTTP/1.1 and curl `--http2` | 422 (both) |
| Chromium page fetch | 200 |

Sending the browser's whole cookie jar with the HTTP/1.1 request changes
nothing, and neither does a matching user agent, so it is the transport framing
(HTTP/2 plus a browser-like fingerprint), not cookies or rate limiting. Every
call therefore goes out over `node:http2` with one retry, then a `fetch`
fallback.

## The browser layer (optional)

If the hub ever challenges the HTTP/2 client too, the client falls back in two
steps, both driven by `solver/` (patchright and the system Chromium; install
once with `cd solver && npm install patchright`). `--no-solve` and
`--no-browser` disable them.

1. `solver/turnstile-solve.js` renders the widget on the fastdl.app origin (an
   implicit `div.cf-turnstile` plus an explicit `turnstile.render`), waits for a
   token, and exchanges it at `POST /api/cf` for the `wh-cf-token` header the API
   wants.
2. `solver/browser-fetch.js` is mirror mode: it opens fastdl.app and replays the
   already-signed request with an in-page `fetch`, so the page's TLS
   fingerprint, cookies and challenge state carry it. This is the idea behind
   sarperavci/CloudflareBypassForScraping, in miniature.

Both can be skipped with a token you already have: `--turnstile <token>` (the
client exchanges it) or `--token <wh-cf-token>` (used as-is). Tokens are cached
in `~/.cache/igdownload.json`.

## Pitfalls handled

- `success:false` refusals come back with **HTTP 200**
  (`{"response":4,"response_type":"link not found","success":false,...}`), so
  status alone is not enough. A refused link is reported as
  `LINK_NOT_FOUND`, an empty extraction as `NO_MEDIA`, and both exit nonzero.
- Carousels change the response shape from object to array. Normalising only the
  object shape silently yields empty media.
- `meta.taken_at` is a timestamp on single items and a string on carousel
  entries, and profile post nodes send `caption` as either a string or
  `{text, pk, created_at}`.
- A carousel container repeats its first slide in the parent node, and a slide's
  thumb points at the same CDN file as the slide itself, so media is read from
  the children and de-duplicated by URL path (the query strings differ between
  the thumb and the download variant).
- `image_versions2.candidates` ships about 12 to 15 sizes of every image
  (largest first). Keeping them all turns one 13-slide carousel into 195 media
  entries, so only the largest is reported and `variant_count` states how many
  exist; `--all-versions` lists them all. Duplicate sizes in `video_versions`
  are collapsed the same way.
- `share_count` does not exist in this API and `like_count`/`comment_count` are
  absent for most carousels. The client reports `null` instead of inventing a
  number.
- Node's `fetch` to `scontent-*.cdninstagram.com` times out from some hosts
  while plain IPv4 TLS works, so downloads go through `node:https` with
  `family: 4` and manual redirects. `dns.setDefaultResultOrder('ipv4first')`
  does not fix `fetch`.
- The h2 connection occasionally stalls during setup; the client retries once
  before dropping to HTTP/1.1 (which is what raises the challenge, so the retry
  matters).
- Instagram CDN hosts are IPv4-addressable but sometimes slow; the download
  path allows 60 seconds of inactivity per file.

## Honest limits

- `share_count` is not exposed anywhere, and play counts only exist on profile
  post nodes (`view_count`), not on `/api/convert` responses.
- The Turnstile fallback is best effort on a headless server. On a GPU-less xvfb
  box the widget loads and fetches its challenge config
  (`/cdn-cgi/challenge-platform/h/g/turnstile/f/av0/rch/...` -> 200) but never
  yields a token, and `window.turnstile` stays undefined even though `api.js`
  loads (WebGL needs `--enable-unsafe-swiftshader --use-gl=angle
  --use-angle=swiftshader`, and `navigator.gpu.requestAdapter()` stays null).
  Mirror mode is what actually carries a challenged request there, verified
  end to end with `--h1`.
- `patchright install chromium` downloads about 187 MB; the client works fine
  with the distro Chromium (`/usr/bin/chromium`) through `executablePath`, which
  is what the solver picks when the bundled build is missing.
- Profile mode is one page per `--pages` step, and each page costs one request;
  the hub is fine with that but do not hammer it.
- Media links are short lived. The signed proxy links expire in about 20
  minutes, and Instagram's own CDN links are IP and session bound.

## Regenerating test fixtures

`verify_igdownload.js` skips its fixture checks when `fixtures/` is empty.
Captured responses are not committed (they contain third-party post data), so
rebuild them from the live API when you want the full run:

```bash
mkdir -p fixtures && node -e '
const ig = require("./igdownload.js"), fs = require("fs");
(async () => {
  for (const [name, path, body] of [
    ["convert-reel", "/api/convert", { target_url: "https://www.instagram.com/reel/DO5tIDME6t-/" }],
    ["convert-carousel", "/api/convert", { target_url: "https://www.instagram.com/p/DEc1QSlIdb_/" }],
    ["userinfo", "/api/v1/instagram/userInfo", { username: "gazdaviesmedia" }],
    ["posts", "/api/v1/instagram/posts", { username: "gazdaviesmedia", maxId: "" }],
  ]) {
    const r = await ig.api(path, body, { solve: false });
    if (r.status !== 200) { console.log(name, "skipped", r.status); continue; }
    let payload = r.json;
    if (name === "posts") payload = { ...payload, result: { ...payload.result, edges: payload.result.edges.slice(0, 3) } };
    fs.writeFileSync(`fixtures/${name}.json`, JSON.stringify(payload));
    console.log(name, "saved");
  }
})();'
```
