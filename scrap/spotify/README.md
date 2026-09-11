# Spotify

Spotify downloader and metadata scraper. One client, one backend. Verified
working 2026-09-11.

| Client | Backend | Gate | Docs |
|---|---|---|---|
| [`spotidown.js`](spotidown.js) | spotidown.app conversion flow | rotating hidden form field plus a `g-recaptcha-response` field that is checked for presence only | [spotidown.md](spotidown.md) |

## What you get

| Input | Outputs |
|---|---|
| Track URL | MP3 audio, HD cover |
| Album URL | every track, each with MP3 audio and HD cover |
| Playlist URL | every track (200-track playlists return in one response), each with MP3 audio and HD cover |
| Search text | the site's own search results, each with MP3 audio and HD cover |

Per track: title, artist, album, duration, release year, Spotify track id, and
the cover URL from Spotify's own CDN. Per input: the collection title, its
artist or owner, and the collection cover. Every media entry carries the signed
URL, the intended filename, and the link expiry decoded from its JWT.

No login, no API key, no browser, no npm install.

## Quick start

```bash
node spotidown.js "https://open.spotify.com/track/0nLiqZ6A27jJri2VCalIUs"
node spotidown.js "https://open.spotify.com/album/6QdCohkHKNTVoaSx1ZzitH" --download ./out
node spotidown.js "spotify:track:0nLiqZ6A27jJri2VCalIUs" --json
node spotidown.js "adele hello" --json
```

JSON goes to stdout, progress to stderr. One URL prints one object, several
print an array. Exit code is 0 when every input succeeded.

## Output shape

| Field | Meaning |
|---|---|
| `source` | the site the data came from |
| `url` | the input as given |
| `type` | `track`, `album`, `playlist` or `search` |
| `page` | collection title, artist or owner, cover URL |
| `trackCount`, `mediaCount` | how many tracks, how many media links in total |
| `albumZip` | whether the site offered its (premium) ZIP button |
| `tracks[]` | one entry per track, see below |

Per track:

| Field | Meaning |
|---|---|
| `index` | position in the collection |
| `title`, `artist`, `album`, `duration`, `year` | metadata as the site reports it |
| `spotifyId` | Spotify track id (from the site's own base64 payload) |
| `cover` | Spotify CDN cover URL |
| `media[]` | `kind` (`audio` or `cover`), `label`, signed `url`, `filename`, `expires` |
| `saved` | only with `--download`: per kind, `path`, `bytes`, and for audio a `quality` block from ffprobe |
| `error`, `code` | only when that one track failed; other tracks still land |

## Audio quality (measured, not advertised)

The site returns exactly one audio file per track. Usually it is MP3 320 kbps
44100 Hz stereo, but a minority of tracks resolve to 128 kbps and stay there.
On Metallica (1991), 5 of 6 tracks came back at 320 kbps while "Enter Sandman"
came back at 128 kbps with byte-identical output on three separate attempts.

There is no quality selector, no 128/192/320 ladder, and no M4A or FLAC. The
bitrate is whatever source the backend resolved for that track, so a client
cannot tune it. `--download` reports the truth per file via ffprobe (`saved.audio.quality`).

## Limits

- Media links are JWT signed and expire 3600 seconds after issue.
- The links only resolve with the session cookie that minted them: replaying
  one from a different session answers HTTP 302 to the site root.
- The site spends roughly 3 seconds per track inside `/action/track`, so a
  200-track playlist is a 10 to 12 minute run. That is server-side; the client
  is idle waiting.
- The album ZIP endpoint is premium-gated above 5 tracks. Per-track downloads
  are free, so `spotidown.js` never uses it.
