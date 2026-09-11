# Instagram

Instagram downloader client and metadata scraper backed by fastdl.app. Verified
working 2026-09-11 against the live API.

| Client | Backend | Gate | Docs |
|---|---|---|---|
| [`igdownload.js`](igdownload.js) | fastdl.app worker hub (`api-wh.fastdl.app`) | HMAC-signed JSON bodies, plus an HTTP/1.1-versus-HTTP/2 client check | [igdownload.md](igdownload.md) |

## What you get

| Input | Outputs |
|---|---|
| Post / reel / IGTV URL | every media item the downloader exposes: video renditions, images, thumbnail, and the post's audio track |
| Carousel URL | one entry per slide, kept in slide order |
| Profile URL or bare username | profile stats, the post feed (12 per page, paginate with `--pages N`), stories and highlights |
| Both | author, caption, likes, comments, views, taken time, shortcode, hosting, the reel's soundtrack, and the DASH manifest split into video and audio renditions |

Every media entry carries the direct CDN URL (decoded out of the downloader's
proxy link), the signed proxy URL, the intended filename and the resolution.
Reel audio comes from the DASH manifest's audio representation, so it is the
soundtrack, not a re-encode.

Not a browser in the normal path: the client signs its own requests and speaks
HTTP/2 to the hub. The `solver/` folder is an optional fallback for the case
where Cloudflare challenges the client, and only then is Chromium started.

## Quick start

```bash
node igdownload.js "https://www.instagram.com/reel/DO5tIDME6t-/"
node igdownload.js "https://www.instagram.com/p/DEc1QSlIdb_/" --download ./out
node igdownload.js gazdaviesmedia --pages 2 --json
node igdownload.js "<url1>" "<url2>" --json          # array out, exit 1 if any failed
```

JSON goes to stdout, logs to stderr, so `| jq` and `| python3 -m json.tool`
work. One input prints one object, several print an array. Exit code is 0 when
every input succeeded.

Optional browser fallback, only needed if the hub starts challenging you:

```bash
cd solver && npm install patchright    # once; uses the system Chromium, no browser download
node igdownload.js "<url>"             # it will use solver/ automatically when challenged
```

## Output shape

| Field | Meaning |
|---|---|
| `kind` | `media` (single item), `album` (carousel) or `profile` |
| `input` | the parsed input: `kind`, `url`, `shortcode` or `username` |
| `source` | original URL, shortcode, hosting site |
| `author` | username and profile URL (profile mode adds pk and full name) |
| `description` | caption or title, plus the caption id when Instagram sends one |
| `stats` | `like_count`, `comment_count`, `share_count`, `play_count`, `taken_at` (+ ISO) |
| `media[]` | `kind` (`video`/`image`/`audio`), `label`, `type`, `ext`, `quality`, `width`, `height`, `bytes`, `filename`, `origin`, `proxy_url`, `direct_url` |
| `items[]` | album mode: the same media grouped per slide (`index`, `media[]`) |
| `dash_manifest` | `duration_seconds`, `adaptation_sets[]`, plus flattened `video[]` and `audio[]` renditions |
| `posts` / `stories` / `highlights` | profile mode, each a `count` plus `items[]` |
| `downloads` | only with `--download`: per file `path`, `bytes` and which source was used |
| `error`, `code` | only on failures, as a sibling of the successes |

A post that the backend refuses (deleted, private, region locked) is not a
success: it lands as `{source, ok:false, url, error, code}` with
`LINK_NOT_FOUND` or `NO_MEDIA`.

## Verification

`verify_igdownload.js` runs 16 checks: the signing vector, the request envelope,
input parsing, normalisation of every response shape, DASH audio extraction,
download naming, failure mapping, and three live checks (HTTP/2 call, a real
media download, solver wiring).

```bash
node verify_igdownload.js
```

The fixture-based checks are skipped unless `fixtures/` holds captured API
responses; `igdownload.md` has the one-liner that regenerates them.

## Limits

- Instagram CDN links are IP, session and time bound; download soon after
  resolving. The downloader's signed proxy links expire in about 20 minutes.
- `share_count` does not exist anywhere in this API, so it is always `null`.
  `like_count` and `comment_count` are missing for most carousels.
- The hub answers HTTP/2 only for challenged clients; see
  [igdownload.md](igdownload.md) for the transport gate and the browser
  fallback's own limits.
