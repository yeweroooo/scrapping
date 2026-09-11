# scrap

Two zero-dependency Node clients for pulling TikTok media and exact metadata.

- [`sstik.js`](sstik.md): backed by the ssstik.io conversion flow
- [`snaptik.js`](snaptik.md): backed by the snaptik.app JSON API (preferred:
  its gate is a solvable client-side challenge, so plain HTTP is enough)

Both require Node >= 18, print JSON to stdout, and share the same result
shape (`type`, `source`, `downloads`, `stats`, `author`, `music`, `video`,
`meta`).

## Capabilities

| Post type | Outputs |
|---|---|
| Video | no-watermark MP4, original-quality HD MP4, MP3 audio, cover image |
| Photo carousel | each slide (metadata + download link), MP3 audio, rendered MP4 of the carousel |
| Both | exact stats (likes, comments, shares, plays, saves), author + follower stats, caption, hashtags, create time, music (title, author, play URL), video duration and dimensions |

## Which one to use

Prefer `snaptik.js`: the challenge is solved in-process, no browser tricks,
and the video links come straight from d.rapidcdn.app. Use `sstik.js` when
snaptik is rate-limiting your IP, or when you specifically want the tikcdn.io
CDN URLs.

Both services rate-limit per IP; space out batch runs with `--delay`.
