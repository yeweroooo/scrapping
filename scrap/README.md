# scrap

Scraper collection. One directory per data source, each holding standalone
zero-dependency Node clients plus their docs.

| Source | Directory | Tools |
|---|---|---|
| TikTok | [`tiktok/`](tiktok/) | [`snaptik.js`](tiktok/snaptik.js) (snaptik.app API), [`sstik.js`](tiktok/sstik.js) (ssstik.io flow) |
| Spotify | [`spotify/`](spotify/) | [`spotidown.js`](spotify/spotidown.js) (spotidown.app flow) |
| Instagram | [`instagram/`](instagram/) | [`igdownload.js`](instagram/igdownload.js) (fastdl.app worker hub) |

The TikTok directory is the reference implementation of the layout below.

## Conventions

- One directory per source: `scrap/<source>/`, for example `scrap/tiktok/`
- One client per backend: `<backend>.js` with a matching `<backend>.md`
- Each source directory has a `README.md` indexing its clients and any
  cross-client differences
- Node >= 18, no npm dependencies (built-in `fetch` and `node:` modules only).
  The one exception is `scrap/instagram/solver/`, an optional browser fallback
  that needs `npm install patchright`; the Instagram client works fully without
  it and only starts a browser when Cloudflare challenges it
- Result JSON on stdout, progress and errors on stderr, one object per input
  URL (array when given several); `--json` switches to compact single-line
- Consistent CLI surface: positional URLs, `--download [dir]`,
  `--delay SECONDS`, `--json`, plus `--no-enrich` and `--no-hd` where they
  apply
- Docs state the honest limits: expiring CDN links, per-IP rate limits, values
  the backend genuinely does not expose
- A nonzero exit code means at least one input failed; failures are reported
  as `{source, error, code}` objects in the same array as successes

## Adding a source

1. `mkdir scrap/<source>`
2. Add `<backend>.js` plus `<backend>.md` covering the flow, the gate, the
   pitfalls and the limits
3. Add `scrap/<source>/README.md` with a client table
4. Add a row to the table above and to the root [README](../README.md)

## Running a client

```bash
node scrap/<source>/<backend>.js "<url>" [--download ./out] [--json] [--delay 3]
```
