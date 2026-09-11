#!/usr/bin/env node
'use strict';
/*
 * spotidown.js: spotidown.app client (Spotify track, album, playlist, search).
 *
 * Plain HTTPS, no dependencies, Node >= 18 (global fetch).
 * Verified 2026-09-11 against spotidown.app/en7.
 *
 * Flow:
 *   1. GET /en7 -> sets the `session_data` cookie and embeds ONE hidden
 *      anti-bot input whose NAME ROTATES per page load (observed _QqpFg,
 *      _lzkTw, _pqyOV, _AvJan). Match it by pattern, never by a fixed name.
 *   2. POST /action (url, <rotating field>, g-recaptcha-response) ->
 *      {error:false, data:"<HTML>"} with one <form name="submitspurl"> per
 *      track: `data` = base64 JSON {name, artist, album, cover, duration,
 *      date, tid}, `base` = the Spotify URL, `token` = per-result token.
 *   3. POST /action/track (data, base, token) -> {error:false, data:"<HTML>"}
 *      holding one <a href="https://rapid.spotidown.app/v2?token=<JWT>"> per
 *      media button: "Download Mp3" (audio), "Download Cover [HD]" (cover).
 *   4. GET rapid.spotidown.app/v2?token=<JWT> with the session cookie ->
 *      200 application/octet-stream plus a Content-Disposition attachment.
 *
 * The gate, and how little of it is real:
 *   - `g-recaptcha-response` is present-only. The server never calls Google:
 *     a deliberately bogus value is accepted. Without the field at all, or
 *     with a rotating field from a stale page load, /action answers
 *     {"error":true,"errorcode":"error_token"} ("refresh the page").
 *   - rapid.spotidown.app answers 302 to the site root when the request
 *     carries no cookie. That is the whole "hotlink protection": the link is
 *     session-cookie bound, not browser bound and not IP bound.
 *   No browser, no Chromium, no captcha solving is required.
 *
 * What the site does not expose:
 *   - One audio rendition per track, no selector and no ladder: usually MP3
 *     320 kbps 44100 Hz stereo, but a minority resolve to 128 kbps and stay
 *     that way. Measured on Metallica (1991): 5 of 6 tracks 320, "Enter
 *     Sandman" 128, identical bytes on three separate attempts. Nothing to
 *     tune client-side: the bitrate is whatever source the backend resolved.
 *     No M4A or FLAC anywhere in the free flow.
 *   - The album ZIP endpoint is premium-gated above 5 tracks; per-track
 *     downloads are free, so this client never uses it.
 *   - Rapid links are JWT signed, expire 3600s after issue, and only resolve
 *     with the cookie from the session that minted them.
 *
 * Usage:
 *   node spotidown.js <spotify-url|spotify:uri|search text> [<more> ...] [options]
 * Options:
 *   --json            single-line JSON (default: 2-space pretty)
 *   --download [dir]  also save media files (default: downloads)
 *   --delay SECONDS   pause between track requests (default: 0.3)
 *   --timeout SECONDS per-request budget (default: 30; media uses 10x)
 *
 * Output: JSON on stdout, progress and errors on stderr.
 */

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SITE = 'https://spotidown.app';
const LANDING = SITE + '/en7';
// any non-empty string satisfies the field; the server does not call Google
const PLACEHOLDER_CAPTCHA = '03AGdBq26placeholder_the_server_only_checks_presence';
const PIPED = process.env.SPOTIDOWN_QUIET !== '1';

class SpotidownError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => {
  if (PIPED) console.error(...a);
};

// session

// Node's fetch has no cookie jar and the site's whole gate is one cookie.
class Session {
  constructor(opts) {
    this.opts = opts;
    this.cookie = '';
  }

  headers(extra = {}) {
    return {
      'User-Agent': DESKTOP_UA,
      Referer: LANDING,
      Origin: SITE,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(this.cookie ? { Cookie: this.cookie } : {}),
      ...extra,
    };
  }

  absorb(res) {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of raw) {
      const kv = c.split(';')[0];
      const name = kv.split('=')[0];
      this.cookie = this.cookie.split('; ')
        .filter((p) => !p.startsWith(name + '='))
        .concat(kv)
        .join('; ');
    }
  }

  async request(url, init = {}, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || this.opts.timeout);
    try {
      const res = await fetch(url, { ...init, headers: this.headers(init.headers), signal: ctrl.signal, redirect: 'manual' });
      this.absorb(res);
      return res;
    } catch (e) {
      if (e.name === 'AbortError') throw new SpotidownError(`timeout after ${(timeoutMs || this.opts.timeout) / 1000}s`, 'TIMEOUT');
      throw new SpotidownError(e.message, 'NETWORK');
    } finally {
      clearTimeout(t);
    }
  }

  get(url, timeoutMs) {
    return this.request(url, {}, timeoutMs);
  }

  postForm(url, fields) {
    return this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
  }
}

async function withRetry(label, attempts, fn) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      // only throttle/rotating-token failures are worth repeating: a "track not
      // found" answer will be identical on the second try
      if (e.fatal || i === attempts) break;
      if (i < attempts) {
        log(`  retry ${i}/${attempts - 1} (${label}): ${e.message}`);
        await sleep(700 * i);
      }
    }
  }
  throw last;
}

// html parsing

// The rotating anti-bot input: <input name="_XyzAb" type="hidden" value="<hex>">
function findRotatingField(html) {
  const m = /<input[^>]*name="(_[A-Za-z0-9]+)"[^>]*value="([^"]+)"[^>]*>/.exec(html);
  if (!m) throw new SpotidownError('anti-bot field not found on the landing page', 'PARSE');
  return { name: m[1], value: m[2] };
}

// `data` is emitted as value='...' (single quotes) while base/token use "..."
function fieldValue(chunk, name) {
  const m = new RegExp('name="' + name + '"\\s+value=(?:"([^"]*)"|\'([^\']*)\')').exec(chunk);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2];
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function textOf(fragment) {
  return decodeEntities(String(fragment).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function parseResultHtml(html) {
  const cover = /<div class="spotidown-downloader-left">\s*<img src="([^"]+)"/.exec(html);
  const title = /<h3 itemprop="name">\s*<div class="hover-underline"[^>]*title="([^"]*)"/.exec(html);
  const artist = /<div class="spotidown-downloader-middle[^>]*>[\s\S]*?<p><span>([^<]+)<\/span><\/p>/.exec(html);

  const tracks = html.split(/<form name="submitspurl"/).slice(1).map((chunk, i) => {
    const card = chunk.slice(0, chunk.indexOf('</form>') + 1);
    const cardTitle = /<a class="hover-underline"[^>]*title="([^"]*)"/.exec(card);
    const cardArtist = /<p><span>([^<]+)<\/span><\/p>/.exec(card);
    const cardCover = /<img src="([^"]+)"/.exec(card);
    return {
      index: i + 1,
      title: cardTitle ? decodeEntities(cardTitle[1]) : null,
      artist: cardArtist ? decodeEntities(cardArtist[1].trim()) : null,
      cover: cardCover ? cardCover[1] : null,
      data: fieldValue(card, 'data'),
      base: fieldValue(card, 'base'),
      token: fieldValue(card, 'token'),
    };
  });

  const loadMore = /id="load-more"[^>]*data-offset="(\d+)"/.exec(html);
  const page = {
    title: title ? decodeEntities(title[1]) : null,
    artist: artist ? decodeEntities(artist[1].trim()) : (tracks[0] && tracks[0].artist) || null,
    cover: cover ? cover[1] : null,
  };
  return {
    page,
    isPlaylist: /id="playlist-songs"/.test(html),
    albumZip: /id="download-full-album"/.test(html),
    loadMoreOffset: loadMore ? Number(loadMore[1]) : null,
    tracks,
  };
}

function parseTrackHtml(html) {
  const media = [];
  const re = /<a[^>]*href="(https:\/\/[^"]*rapid\.spotidown\.app[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) media.push({ label: textOf(m[2]), url: m[1] });
  const title = /<h3 itemprop="name">\s*<div class="hover-underline"[^>]*title="([^"]*)"/.exec(html);
  const artist = /<div class="spotidown-downloader-middle[^>]*>[\s\S]*?<p><span>([^<]+)<\/span><\/p>/.exec(html);
  const cover = /<div class="spotidown-downloader-left">\s*<img src="([^"]+)"/.exec(html);
  return {
    title: title ? decodeEntities(title[1]) : null,
    artist: artist ? decodeEntities(artist[1].trim()) : null,
    cover: cover ? cover[1] : null,
    media,
  };
}

function classifyMedia(label) {
  const l = String(label || '').toLowerCase();
  if (l.includes('cover')) return 'cover';
  if (l.includes('mp3') || l.includes('m4a') || l.includes('flac')) return 'audio';
  return 'other';
}

// The rapid JWT is HS256 with an unknown secret, but its payload is plain
// base64url: filename, iat, exp (always 3600s apart).
function decodeJwt(url) {
  const m = /[?&]token=([A-Za-z0-9._-]+)/.exec(url || '');
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length < 2) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return {
      filename: p.filename || null,
      issued: p.iat ? new Date(p.iat * 1000).toISOString() : null,
      expires: p.exp ? new Date(p.exp * 1000).toISOString() : null,
    };
  } catch (_) {
    return null;
  }
}

function decodeTrackData(b64) {
  try {
    return JSON.parse(Buffer.from(String(b64), 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

// input

function classifyInput(raw) {
  const s = String(raw).trim();
  const url = /(?:open\.spotify\.com|spotify\.com)\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)/.exec(s);
  if (url) return { type: url[1], id: url[2], query: s };
  const uri = /^spotify:(track|album|playlist|artist|episode|show):([A-Za-z0-9]+)$/.exec(s);
  // the site takes URLs or free text, not spotify: URIs: it searches them instead
  if (uri) return { type: uri[1], id: uri[2], query: `https://open.spotify.com/${uri[1]}/${uri[2]}` };
  return { type: 'search', id: null, query: s };
}

// extract

async function extract(session, raw, opts) {
  const input = classifyInput(raw);
  log(`  ${input.type}: ${input.query}`);

  let data = null;
  let field = null;
  await withRetry('action', 3, async (attempt) => {
    const page = await session.get(LANDING);
    if (!page.ok) throw new SpotidownError(`landing page HTTP ${page.status}`, 'HTTP');
    field = findRotatingField(await page.text());

    const res = await session.postForm(SITE + '/action', {
      url: input.query,
      [field.name]: field.value,
      'g-recaptcha-response': PLACEHOLDER_CAPTCHA,
    });
    const body = await res.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch (_) {
      throw new SpotidownError(`unparseable /action response (HTTP ${res.status})`, 'PARSE');
    }
    if (json.error) {
      // "refresh the page" (error_token): the rotating field must come from a
      // page load in this same session, so reload and try again. Anything else
      // (for example "Spotify Track not found") is final.
      const err = new SpotidownError(json.message || 'request refused',
        json.errorcode === 'error_token' ? 'TOKEN' : 'REFUSED');
      if (err.code !== 'TOKEN') err.fatal = true;
      throw err;
    }
    data = String(json.data || '');
  });

  const list = parseResultHtml(data);
  let tracks = list.tracks;

  // "Load More" for long lists: the same landing fields plus an offset. The
  // endpoint answers with the accumulated set, so take the superset and dedupe.
  let offset = list.loadMoreOffset;
  for (let guard = 0; offset !== null && guard < 60; guard++) {
    log(`  loading more tracks at offset ${offset}`);
    const frag = await withRetry(`offset ${offset}`, 3, async () => {
      const res = await session.postForm(SITE + '/action/offset', {
        url: input.query,
        [field.name]: field.value,
        'g-recaptcha-response': PLACEHOLDER_CAPTCHA,
        offset: String(offset),
      });
      return res.text();
    });
    const more = parseResultHtml(frag);
    if (!more.tracks.length) break;
    const merged = more.tracks.length >= tracks.length ? more.tracks : tracks.concat(more.tracks);
    const seen = new Set();
    tracks = merged.filter((t) => {
      const meta = decodeTrackData(t.data);
      const key = (meta && meta.tid) || `${t.title}|${t.index}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (more.loadMoreOffset === null || more.loadMoreOffset === offset) break;
    offset = more.loadMoreOffset;
    await sleep(opts.delay);
  }

  if (!tracks.length) throw new SpotidownError('no tracks in response', 'EMPTY');
  log(`  ${tracks.length} track(s)`);

  const result = {
    source: SITE,
    url: raw,
    type: list.isPlaylist ? 'playlist' : input.type,
    page: list.page,
    trackCount: tracks.length,
    mediaCount: 0,
    albumZip: list.albumZip,
    tracks: [],
  };

  for (const t of tracks) {
    const meta = decodeTrackData(t.data);
    const track = {
      index: t.index,
      title: (meta && meta.name) || t.title,
      artist: (meta && meta.artist) || t.artist,
      album: (meta && meta.album) || (input.type === 'album' ? list.page.title : null),
      cover: (meta && meta.cover) || t.cover,
      duration: (meta && meta.duration) || null,
      year: (meta && meta.date) || null,
      spotifyId: (meta && meta.tid) || null,
      media: [],
    };
    try {
      if (!t.data || !t.token) throw new SpotidownError('track form missing data/token', 'PARSE');
      const html = await withRetry(`track ${t.index}`, 3, async () => {
        const res = await session.postForm(SITE + '/action/track', {
          data: t.data,
          base: t.base || input.query,
          token: t.token,
        });
        const json = JSON.parse(await res.text());
        if (json.error) throw new SpotidownError(json.message || 'track refused', 'TRACK');
        return String(json.data || '');
      });
      track.media = parseTrackHtml(html).media.map((m) => {
        const jwt = decodeJwt(m.url);
        return {
          kind: classifyMedia(m.label),
          label: m.label,
          url: m.url,
          filename: jwt ? jwt.filename : null,
          expires: jwt ? jwt.expires : null,
        };
      });
      result.mediaCount += track.media.length;
      log(`  ${t.index}/${tracks.length} ${track.title} -> ${track.media.length} link(s)`);
    } catch (e) {
      track.error = e.message;
      track.code = e.code || null;
      log(`  ${t.index}/${tracks.length} ${track.title} failed: ${e.message}`);
    }
    result.tracks.push(track);
    await sleep(opts.delay);
  }

  if (opts.download) {
    for (const track of result.tracks) {
      track.saved = {};
      for (const m of track.media) {
        try {
          track.saved[m.kind] = await saveMedia(session, m, opts);
        } catch (e) {
          track.saved[m.kind] = { error: e.message, code: e.code || null };
        }
      }
    }
  }
  return result;
}

// download

async function saveMedia(session, media, opts) {
  const res = await withRetry('download', 3, () => session.get(media.url, opts.timeout * 10));
  if (res.status !== 200) {
    throw new SpotidownError(`HTTP ${res.status} (link expired, or session lost)`, 'DOWNLOAD');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new SpotidownError(`file looks empty (${buf.length} bytes)`, 'DOWNLOAD');

  const disp = res.headers.get('content-disposition') || '';
  const named = /filename="?([^";]+)"?/.exec(disp);
  const name = sanitize(named ? named[1] : `${media.filename || media.kind}${extension(res.headers.get('content-type'))}`);
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(opts.download, { recursive: true });
  const full = `${opts.download}/${name}`;
  await writeFile(full, buf);
  const saved = { path: full, bytes: buf.length };
  if (media.kind === 'audio') saved.quality = probeAudio(full);
  return saved;
}

function sanitize(name) {
  return String(name).replace(/[/\\:*?"<>|]/g, '_').trim();
}

function extension(contentType) {
  const t = String(contentType || '');
  if (t.includes('mpeg')) return '.mp3';
  if (t.includes('jpeg')) return '.jpg';
  if (t.includes('png')) return '.png';
  return '.bin';
}

// ffprobe is optional: it only adds the real audio properties to the output
function probeAudio(file) {
  const r = require('node:child_process').spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries',
    'stream=codec_name,bit_rate,sample_rate,channels:format=bit_rate,duration',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  try {
    const j = JSON.parse(r.stdout);
    const s = (j.streams || [])[0] || {};
    const kbps = (v) => (v ? Math.round(Number(v) / 1000) + ' kbps' : null);
    return {
      codec: s.codec_name || null,
      bitrate: kbps(s.bit_rate || j.format.bit_rate),
      sampleRate: s.sample_rate ? Number(s.sample_rate) : null,
      channels: s.channels || null,
      durationSeconds: j.format.duration ? Number(j.format.duration) : null,
    };
  } catch (_) {
    return null;
  }
}

// CLI

function usage() {
  return [
    'usage: node spotidown.js <spotify-url|spotify:uri|search text> [<more> ...] [options]',
    '',
    'options:',
    '  --json             single-line JSON (default: 2-space pretty)',
    '  --download [dir]   also save media files (default: downloads)',
    '  --delay SECONDS    pause between track requests (default: 0.3)',
    '  --timeout SECONDS  per-request budget (default: 30; media uses 10x)',
    '',
    'prints one JSON object per input (array when given several), stdout only.',
  ].join('\n');
}

async function main(argv) {
  const urls = [];
  let pretty = true;
  let downloadDir = null;
  let delayMs = 300;
  let timeoutMs = 30000;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') pretty = false;
    else if (a === '--delay') {
      delayMs = (parseFloat(argv[++i]) || 0) * 1000;
    } else if (a === '--timeout') {
      const seconds = parseFloat(argv[++i]);
      if (!seconds) {
        console.error(`--timeout needs a number\n\n${usage()}`);
        process.exit(2);
      }
      timeoutMs = seconds * 1000;
    } else if (a === '--download') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        downloadDir = next;
        i++;
      } else downloadDir = 'downloads';
    } else if (a === '-h' || a === '--help') {
      console.error(usage());
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`unknown option: ${a}\n\n${usage()}`);
      process.exit(2);
    } else urls.push(a);
  }

  if (!urls.length) {
    console.error(usage());
    process.exit(2);
  }

  const opts = { download: downloadDir, delay: delayMs, timeout: timeoutMs };
  const session = new Session(opts);
  const results = [];

  for (let i = 0; i < urls.length; i++) {
    log(`[${i + 1}/${urls.length}] ${urls[i]}`);
    try {
      const r = await extract(session, urls[i], opts);
      results.push(r);
      log(`  ok: ${r.type}, ${r.trackCount} track(s), ${r.mediaCount} media link(s)`);
    } catch (e) {
      log(`  error: ${e.message}`);
      results.push({ source: urls[i], error: e.message, code: e.code || null });
    }
  }

  const payload = results.length === 1 ? results[0] : results;
  process.stdout.on('error', (e) => {
    if (e && e.code === 'EPIPE') process.exit(0);
  });
  console.log(JSON.stringify(payload, null, pretty ? 2 : 0));
  process.exit(results.some((r) => r.error) ? 1 : 0);
}

module.exports = { extract, classifyInput, parseResultHtml, parseTrackHtml, decodeJwt, saveMedia, session: Session };

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.log(JSON.stringify({ error: e.message, code: e.code || null }, null, 2));
    process.exit(1);
  });
}
