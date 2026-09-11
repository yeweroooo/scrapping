# spotidown.js

Spotify downloader client and metadata scraper backed by spotidown.app.
Single file, no dependencies, Node >= 18 (built-in `fetch`).
Verified working 2026-09-11 against spotidown.app/en7 and its live flow.

## Capabilities

| Input | Outputs |
|---|---|
| Track | MP3 audio, HD cover |
| Album | every track, MP3 audio plus HD cover each |
| Playlist | every track, MP3 audio plus HD cover each (a 200-track playlist returns in one response) |
| Search text | the site's own results, MP3 audio plus HD cover each |
| Both | title, artist, album, duration, release year, Spotify track id, Spotify CDN cover URL, collection title and owner |

## Usage

```bash
node spotidown.js "https://open.spotify.com/track/0nLiqZ6A27jJri2VCalIUs"
node spotidown.js "https://open.spotify.com/album/6QdCohkHKNTVoaSx1ZzitH" --download ./out
node spotidown.js "adele hello" --json
```

Prints one JSON object to stdout (an array when given several inputs). Exit
code is 0 when every input succeeded. Logs go to stderr, so piping to `jq` or
`python3 -m json.tool` works.

### Options

- `--json` : compact single-line JSON (default is 2-space pretty)
- `--download [dir]` : save media to dir (default `./downloads`)
- `--delay SECONDS` : pause between track requests (default 0.3)
- `--timeout SECONDS` : per-request budget (default 30; media downloads get 10x)

### Module usage

```js
const { extract, session: Session } = require('./spotidown.js');

const s = new Session({ timeout: 30000, delay: 300, download: null });
const r = await extract(s, 'https://open.spotify.com/track/0nLiqZ6A27jJri2VCalIUs', { delay: 300, timeout: 30000 });
console.log(r.tracks[0].title, r.tracks[0].media.map((m) => m.kind));
```

Exports: `extract`, `classifyInput`, `parseResultHtml`, `parseTrackHtml`,
`decodeJwt`, `saveMedia`, `session`.

## The flow, in order

1. `GET https://spotidown.app/en7` sets the `session_data` cookie and embeds one
   hidden anti-bot input. **Its name rotates on every page load** (observed
   `_QqpFg`, `_lzkTw`, `_pqyOV`, `_AvJan`), so match it by pattern.
2. `POST /action` with `url`, that rotating field, and `g-recaptcha-response`
   returns `{error:false, data:"<HTML>"}`. The HTML holds one
   `<form name="submitspurl">` per track carrying `data` (base64 JSON:
   `name`, `artist`, `album`, `cover`, `duration`, `date`, `tid`), `base` (the
   Spotify URL) and a per-result `token`.
3. `POST /action/track` with `data`, `base`, `token` returns the media buttons,
   each an `<a href="https://rapid.spotidown.app/v2?token=<JWT>">`: "Download
   Mp3" for the audio and "Download Cover [HD]" for the artwork.
4. `GET` that rapid URL **with the session cookie** returns 200
   `application/octet-stream` with a `Content-Disposition` attachment named
   `SpotiDown.App - <Title> - <Artist>.mp3` (or `.jpeg`).

## The gate, and how little of it is real

- `g-recaptcha-response` is **presence only**. The server never calls Google:
  a deliberately bogus value (`03AGdBq26placeholder...`, or 40 x-characters) is
  accepted and returns normal results.
- What actually fails is: omitting the field entirely, or sending a rotating
  field from a stale page load. Both answer
  `{"error":true,"message":"Please Refresh the page & try again.","errorcode":"error_token"}`.
- rapid.spotidown.app answers 302 to the site root when the request carries no
  cookie. That is the entire hotlink protection: the link is session-cookie
  bound, **not** browser bound and **not** IP bound, so plain HTTP downloads the
  full file.

This matters because the first two symptoms read like "captcha and browser
required". They are not, and a Chromium client built on that reading works but
is strictly unnecessary.

## Token and link facts

- The rotating field is per page load and tied to the session cookie. The client
  fetches a fresh landing page for every input and retries `error_token`
  failures with a new page load.
- Media links are HS256 JWTs with an unknown secret, but the payload is plain
  base64url: `filename`, `iat`, `exp`, always 3600 seconds apart. The client
  reports `expires` per media entry.
- Media links are single-source: replaying one from another session (or another
  IP without the cookie) redirects to the site root.

## Pitfalls handled

- The `data` value is emitted with **single quotes** (`value='eyJu...'`) while
  `base` and `token` use double quotes. A double-quote-only regex silently
  returns `null` for `data`, which then looks like a missing field.
- The rotating anti-bot field must be paired with a page load from the same
  session; a cached one produces `error_token`.
- `spotify:` URIs are not accepted by the site: it treats them as a search
  query. The client rewrites `spotify:track:ID` to
  `https://open.spotify.com/track/ID` before submitting.
- Media downloads are large (15.5 MB for a 6:28 track) and slow on a thin link,
  so they get 10x the per-request timeout instead of tripping the normal budget.
- "Track not found" is a final answer: only `error_token` failures retry.

## Honest limits

- **One audio file per track, and the bitrate varies per track.** Usually MP3
  320 kbps 44100 Hz stereo, but some tracks resolve to 128 kbps and stay there.
  Metallica (1991): 5 of 6 tracks at 320 kbps, "Enter Sandman" at 128 kbps,
  byte-identical on three separate attempts. There is no selector and no
  M4A/FLAC, so this cannot be tuned client-side.
- Links expire 3600 seconds after issue; download soon after resolving.
- The site spends roughly 3 seconds per track in `/action/track`, so a 200-track
  playlist is a 10 to 12 minute run. That cost is server-side.
- The site's own `#load-more` pagination is implemented defensively (the client
  dedupes and keeps the superset) but no tested input triggered it: a 200-track
  playlist and a 13-result search both arrived complete in one response.
- The album ZIP endpoint is premium-gated above 5 tracks; per-track downloads
  are free, so this client never uses it.

For research and education only. Respect spotidown.app's terms of service and
Spotify's.
