#!/usr/bin/env node
'use strict';
/*
 * igdownload.js - fastdl.app (Instagram) API client, no browser, no dependencies.
 *
 * The site fronts its Instagram API with api-wh.fastdl.app. Every request must carry a
 * signature: HMAC-SHA256(key, JSON.stringify(body with top-level keys sorted) + ts), sent
 * back in the body as _s next to ts/_ts/_tsc/_sv. The signing code lives in the site's
 * obfuscated js/link.chunk.js; the key below was recovered from it and re-verified against
 * signatures that chunk itself produced. If fastdl.app redeploys, the key can change: the
 * script detects the rejection (401 REQUEST_SIGNATURE_*) and re-derives the key by running
 * the site's own chunk in a sandbox (see refreshKey()).
 *
 * Transport: the hub answers HTTP 422 CAPTCHA_REQUIRED to HTTP/1.1 clients that are not a browser
 * and serves the same request over HTTP/2, so every call goes out through node:http2. If that is
 * challenged too, the script falls back in two steps, both driven by solver/ (patchright + the
 * box's Chromium, see solver/*.js):
 *   1. mint a Turnstile token on the fastdl.app origin and retry with the wh-cf-token header
 *   2. replay the request from inside a real browser page (mirror mode, like
 *      sarperavci/CloudflareBypassForScraping), which carries the browser's TLS and cookies
 * Both fallbacks can be disabled: --no-solve, --no-browser. solver/ needs `npm install patchright`
 * once; without it the HTTP/2 path still covers everything.
 *
 * Endpoints used:
 *   POST /api/convert              {target_url}                     reel, post, tv, carousel, photo
 *   POST /api/v1/instagram/userInfo{username}                       profile header
 *   POST /api/v1/instagram/posts   {username, maxId}                post/reel list, 12 per page
 *   POST /api/v1/instagram/stories {username}                       active stories
 *   POST /api/v1/instagram/story   {url}                            single story
 *   POST /api/v1/instagram/highlights {userId}                      highlight reels
 *   POST /api/cf                   cfToken=<turnstile token>        exchange for wh-cf-token
 *
 * Usage:
 *   node igdownload.js <instagram-url | username> [options]
 * Options: --out FILE  --compact  --raw  --download [DIR]  --pages N  --all-versions
 *          --token T  --turnstile T  --no-solve  --no-browser  --solve-timeout MS
 *          --refresh-key  --key HEX  --timeout MS  --h1
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http2 = require('http2');
const { spawnSync } = require('child_process');

const SITE = 'https://fastdl.app';
const HUB = 'https://api-wh.fastdl.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CACHE_FILE = path.join(os.homedir(), '.cache', 'igdownload.json');
const SIG_VERSION = 2;
const FIXED_TS = 1788421776280; // constant the site's signer always sends as _ts
const KEY_HEX = '6632138f3b8f4f0ac4bba56d338f913fdfd5481947c9d20ca7b557b96bce7574';
const DEFAULT_TURNSTILE_SITEKEY = '0x4AAAAAABhLwGG2XCb7fE2M';

let signKey = Buffer.from(KEY_HEX, 'hex');
// Instagram ships every image resize in image_versions2; by default only the largest is reported.
let includeAllVersions = false;

// ---------------------------------------------------------------- cache (key + captcha token)

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}

function writeCache(patch) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ...readCache(), ...patch }, null, 2));
  } catch { /* cache is optional */ }
}

// ---------------------------------------------------------------- signing

function stableStringify(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

function signBody(body, ts = Date.now()) {
  const msg = stableStringify(body) + ts;
  const sig = crypto.createHmac('sha256', signKey).update(msg, 'utf8').digest('hex');
  return { ...body, ts, _ts: FIXED_TS, _tsc: 0, _sv: SIG_VERSION, _s: sig };
}

/*
 * Re-derive the HMAC key by executing the site's own chunk in a vm sandbox and intercepting
 * the key it hands to WebCrypto. Only runs when the server reports the signature as invalid.
 */
async function refreshKey() {
  const vm = require('vm');
  const page = await (await fetch(SITE + '/', { headers: { 'User-Agent': UA } })).text();
  const appMatch = page.match(/\/js\/app\.js\?id=([0-9a-f]+)/);
  if (!appMatch) throw new Error('app.js id not found in landing page');
  const appJs = await (await fetch(`${SITE}/js/app.js?id=${appMatch[1]}`, { headers: { 'User-Agent': UA, Referer: SITE + '/' } })).text();
  // the landing page's bundle maps webpack chunk 54 to js/link.chunk.js?ch=<hash>
  const chunkMatch = appJs.match(/js\/link\.chunk\.js\?ch=([0-9a-f]+)/) || appJs.match(/54===e\?"link\.chunk":e\)\+"\.js\?ch="\+\{[^}]*54:"([0-9a-f]+)"/);
  if (!chunkMatch) throw new Error('link.chunk.js hash not found in app.js');
  const chunk = await (await fetch(`${SITE}/js/link.chunk.js?ch=${chunkMatch[1]}`, { headers: { 'User-Agent': UA, Referer: SITE + '/' } })).text();

  const captured = [];
  const seen = { op: null, key: null };
  const makeArray = () => {
    const a = [];
    Object.defineProperty(a, 'push', { value: (x) => (captured.push(x), Array.prototype.push.call(a, x)), enumerable: false });
    return a;
  };
  const store = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null), setItem: (k, v) => m.set(String(k), String(v)), removeItem: (k) => m.delete(String(k)), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
  };
  const realSubtle = crypto.webcrypto.subtle;
  const sandboxBase = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    localStorage: store(), sessionStorage: store(),
    crypto: {
      getRandomValues: (a) => crypto.webcrypto.getRandomValues(a),
      randomUUID: () => crypto.webcrypto.randomUUID(),
      subtle: {
        importKey: async (...args) => {
          if (args[0] === 'raw' && args[2] && args[2].name === 'HMAC') seen.key = Buffer.from(args[1]).toString('hex');
          return realSubtle.importKey(...args);
        },
        sign: (...args) => realSubtle.sign(...args),
        digest: (...args) => realSubtle.digest(...args),
        encrypt: (...args) => realSubtle.encrypt(...args),
        decrypt: (...args) => realSubtle.decrypt(...args),
        deriveBits: (...args) => realSubtle.deriveBits(...args),
      },
    },
    fetch: () => Promise.resolve({ ok: false, status: 0, text: async () => '', json: async () => ({}) }),
    navigator: { userAgent: UA, language: 'en-US', languages: ['en-US'], platform: 'Win32', onLine: true, webdriver: false },
    location: { href: SITE + '/', hostname: 'fastdl.app', origin: SITE, pathname: '/', search: '', protocol: 'https:' },
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => ({ setAttribute() {}, style: {}, addEventListener() {}, appendChild() {}, remove() {} }), documentElement: { style: {}, setAttribute() {}, getAttribute: () => null }, head: { appendChild() {} }, body: { appendChild() {} }, cookie: '' },
  };
  let sandbox;
  sandbox = new Proxy(sandboxBase, {
    has: () => true,
    get(t, p) {
      if (p === 'self' || p === 'window' || p === 'globalThis' || p === 'top' || p === 'parent') return sandbox;
      if (typeof p === 'symbol') return t[p];
      if (p in t) return t[p];
      if (p in globalThis) return globalThis[p];
      const a = makeArray();
      t[p] = a;
      return a;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
  vm.createContext(sandbox);
  vm.runInContext(chunk, sandbox, { filename: 'link.chunk.js' });

  const payload = captured.find((c) => Array.isArray(c) && c.find((x) => x && typeof x === 'object' && !Array.isArray(x)));
  if (!payload) throw new Error('chunk module map not captured');
  const mods = payload.find((x) => x && typeof x === 'object' && !Array.isArray(x));
  const cache = {};
  const wreq = (id) => {
    if (cache[id]) return cache[id].exports;
    const m = { id, exports: {} };
    cache[id] = m;
    if (!mods[id]) throw new Error('missing webpack module ' + id);
    mods[id](m, m.exports, wreq);
    return m.exports;
  };
  wreq.r = (e) => { Object.defineProperty(e, '__esModule', { value: true }); };
  wreq.n = (m) => { const g = m && m.__esModule ? () => m.default : () => m; wreq.d(g, { a: g }); return g; };
  wreq.d = (e, d) => { for (const k in d) if (!Object.prototype.hasOwnProperty.call(e, k)) Object.defineProperty(e, k, { enumerable: true, get: d[k] }); };
  wreq.o = (o, p) => Object.prototype.hasOwnProperty.call(o, p);
  wreq.g = globalThis;
  const signer = await wreq(7027).default;
  await signer({ probe: 1 });
  if (!seen.key) throw new Error('HMAC key not observed');
  return seen.key;
}

// ---------------------------------------------------------------- HTTP

/*
 * The hub challenges HTTP/1.1 clients that are not a browser (HTTP 422 CAPTCHA_REQUIRED with a
 * Turnstile challenge) while the same request over HTTP/2 is served normally. All API calls go
 * out over node:http2; fetch stays as a fallback for transports that cannot do h2.
 */
function http2Post(hostname, pathname, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = http2.connect('https://' + hostname);
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.close();
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => done(new Error('timeout after ' + (timeoutMs || 30000) + 'ms')), timeoutMs || 30000);
    client.on('error', (err) => done(err));
    const lower = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    const req = client.request({ ':method': 'POST', ':path': pathname, ...lower, 'content-length': Buffer.byteLength(body) });
    let status = 0;
    let text = '';
    req.setEncoding('utf8');
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => done(null, { status, text }));
    req.on('error', (err) => done(err));
    req.end(body);
  });
}

async function api(pathname, body, opts = {}) {
  const signed = signBody(body);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Origin: SITE,
    Referer: SITE + '/',
    'User-Agent': UA,
  };
  const token = opts.token || process.env.FASTDL_TOKEN;
  if (token) headers['x-token'] = token;
  const cf = opts.whCfToken || readCache().whCfToken;
  if (cf) headers['wh-cf-token'] = cf;

  const payload = JSON.stringify(signed);
  let status = 0;
  let text = '';
  let transport = 'http2';
  if (opts.forceH1) {
    transport = 'fetch (http/1.1 forced)';
    const res = await fetch(HUB + pathname, { method: 'POST', headers, body: payload, signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined });
    status = res.status;
    text = await res.text();
  } else {
    try {
      // h2 connection setup occasionally stalls: one retry before falling back to HTTP/1.1
      const hostname = new URL(HUB).hostname;
      let res;
      try {
        res = await http2Post(hostname, pathname, headers, payload, opts.timeout || 30000);
      } catch {
        res = await http2Post(hostname, pathname, headers, payload, opts.timeout || 30000);
      }
      status = res.status;
      text = res.text;
    } catch (err) {
      transport = 'fetch (h2 failed: ' + err.message + ')';
      const res = await fetch(HUB + pathname, { method: 'POST', headers, body: payload, signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined });
      status = res.status;
      text = await res.text();
    }
  }
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (status === 422 && json && json.code === 'CAPTCHA_REQUIRED') {
    // 1) mint a Turnstile token in a stealth browser and retry with the wh-cf-token header
    if (opts.solve !== false && !opts.retriedToken) {
      const token = solveCaptcha(json.challenge, opts.solveTimeout);
      if (token) {
        writeCache({ whCfToken: token, whCfTokenAt: Date.now() });
        return api(pathname, body, { ...opts, whCfToken: token, retriedToken: true });
      }
    }
    // 2) replay the request from inside the browser page (mirror mode): browser TLS plus whatever
    //    challenge state the page holds, which is what the reference repo does too
    if (opts.browserFallback !== false && !opts.retriedInBrowser) {
      const mirrored = browserFetch(pathname, payload, opts.solveTimeout);
      if (mirrored) {
        if (mirrored.whCfToken) writeCache({ whCfToken: mirrored.whCfToken, whCfTokenAt: Date.now() });
        if (mirrored.status === 200) return { status: 200, json: mirrored.json, transport: 'browser (mirror mode)' };
      }
    }
  }
  return { status, json, transport };
}

/*
 * Replays one signed request from inside a real browser page via solver/browser-fetch.js.
 * Returns {status, json, whCfToken} or null when the solver folder is not installed.
 */
function browserFetch(pathname, payload, timeoutMs) {
  const script = path.join(__dirname, 'solver', 'browser-fetch.js');
  if (!fs.existsSync(script)) return null;
  const args = [script, '--path', pathname, '--body', payload, '--timeout', String(timeoutMs || 60000)];
  const command = process.env.DISPLAY ? process.execPath : 'xvfb-run';
  const argv = process.env.DISPLAY ? args : ['-a', process.execPath, ...args];
  process.stderr.write('replaying the request from inside a browser (mirror mode)\n');
  const res = spawnSync(command, argv, { encoding: 'utf8', timeout: (timeoutMs || 60000) + 90000, maxBuffer: 32 * 1024 * 1024 });
  const line = (res.stdout || '').trim().split('\n').pop();
  try {
    const parsed = JSON.parse(line);
    if (!parsed.ok || parsed.status === undefined) {
      process.stderr.write(`browser mirror failed: ${parsed.error || parsed.status}\n`);
      return null;
    }
    let json;
    try { json = JSON.parse(parsed.body); } catch { json = { raw: parsed.body }; }
    return { status: parsed.status, json, whCfToken: parsed.wh_cf_token || null };
  } catch {
    process.stderr.write(`browser mirror produced no JSON: ${(res.stderr || '').slice(-300)}\n`);
    return null;
  }
}

/*
 * Spawns solver/turnstile-solve.js (patchright + the box's Chromium) to mint a Turnstile token and
 * exchange it for a wh-cf-token. Returns null when the solver folder is absent, so the CLI can still
 * report the challenge instead of failing.
 */
function solveCaptcha(challenge, timeoutMs) {
  const solverPath = path.join(__dirname, 'solver', 'turnstile-solve.js');
  if (!fs.existsSync(solverPath)) return null;
  const siteKey = (challenge && challenge.siteKey) || DEFAULT_TURNSTILE_SITEKEY;
  const args = [solverPath, '--exchange', '--sitekey', siteKey, '--timeout', String(timeoutMs || 90000)];
  const command = process.env.DISPLAY ? process.execPath : 'xvfb-run';
  const argv = process.env.DISPLAY ? args : ['-a', process.execPath, ...args];
  process.stderr.write(`solving turnstile with a real browser (${siteKey})\n`);
  const res = spawnSync(command, argv, { encoding: 'utf8', timeout: (timeoutMs || 90000) + 60000, maxBuffer: 8 * 1024 * 1024 });
  const line = (res.stdout || '').trim().split('\n').pop();
  try {
    const parsed = JSON.parse(line);
    if (parsed.ok && parsed.wh_cf_token) return parsed.wh_cf_token;
    process.stderr.write(`turnstile solver failed: ${parsed.error}\n`);
  } catch {
    process.stderr.write(`turnstile solver produced no JSON: ${(res.stderr || '').slice(-300)}\n`);
  }
  return null;
}

async function exchangeTurnstile(cfToken) {
  const res = await fetch(HUB + '/api/cf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: SITE, Referer: SITE + '/', 'User-Agent': UA },
    body: new URLSearchParams({ cfToken }),
  });
  const json = await res.json().catch(() => ({}));
  if (typeof json.result !== 'string' || !json.result) throw new Error('wh-cf-token exchange failed: ' + JSON.stringify(json));
  writeCache({ whCfToken: json.result });
  return json.result;
}

// ---------------------------------------------------------------- input parsing

function parseInput(value) {
  const v = String(value || '').trim();
  if (!v) throw new Error('no instagram url or username given');
  const urlLike = /^https?:\/\//i.test(v) || /^(www\.)?instagram\.com\//i.test(v);
  if (!urlLike) {
    const username = v.replace(/^@/, '').replace(/\/+$/, '');
    if (!/^[A-Za-z0-9._]{1,60}$/.test(username)) throw new Error('not a url and not a valid username: ' + v);
    return { kind: 'profile', username, url: `https://www.instagram.com/${username}/` };
  }
  const url = v.startsWith('http') ? v : 'https://' + v;
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  const out = { url: `https://www.instagram.com${u.pathname.replace(/\/+$/, '')}/` };
  if (parts[0] === 'stories') return { ...out, kind: 'story', username: parts[1] || null, storyId: parts[2] || null };
  if (['p', 'reel', 'reels', 'tv', 'share'].includes(parts[0]) && parts[1]) {
    const kind = parts[0] === 'reel' || parts[0] === 'reels' ? 'reel' : parts[0] === 'tv' ? 'tv' : 'post';
    return { ...out, kind: kind === 'share' ? 'post' : kind, shortcode: parts[1] };
  }
  if (parts.length === 1) return { ...out, kind: 'profile', username: parts[0] };
  return { ...out, kind: 'unknown' };
}

// ---------------------------------------------------------------- normalisation

// the same CDN file reached through different query strings (thumb vs download variant)
function sameFile(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try { return new URL(a).pathname === new URL(b).pathname; } catch { return false; }
}

function extFromUrl(url) {
  if (!url) return null;
  try {
    const m = new URL(url).pathname.match(/\.([A-Za-z0-9]{2,5})$/);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoTimestamp(seconds) {
  const n = numberOrNull(seconds);
  return n ? new Date(n * 1000).toISOString() : null;
}

function mediaEntry(entry, origin, extra = {}) {
  if (!entry) return null;
  const record = typeof entry === 'string' ? { url: entry } : entry;
  const proxyUrl = record.url || record.downloadUrl || null;
  let directUrl = null;
  let filename = record.filename || null;
  if (proxyUrl && proxyUrl.includes('media.fastdl.app/get')) {
    const q = new URL(proxyUrl).searchParams;
    directUrl = q.get('uri');
    filename = filename || q.get('filename');
  } else if (proxyUrl && /^https?:\/\//.test(proxyUrl)) {
    directUrl = proxyUrl;
  }
  const ext = record.ext || extFromUrl(filename) || extFromUrl(directUrl);
  const type = record.type || ext || null;
  const t = String(type || '').toLowerCase();
  const kind = /^(mp4|mov|webm|m4v)$/.test(t) ? 'video'
    : /^(jpg|jpeg|png|webp|heic|avif)$/.test(t) ? 'image'
    : /^(mp3|m4a|aac|audio)$/.test(t) ? 'audio'
    : (t || 'unknown');
  return {
    kind,
    label: record.subname || record.name || (record.quality ? `${record.quality}p` : null),
    type,
    ext,
    quality: numberOrNull(record.quality),
    width: numberOrNull(record.width),
    height: numberOrNull(record.height),
    bytes: numberOrNull(record.size ?? record.content_length),
    filename,
    origin,
    proxy_url: proxyUrl,
    direct_url: directUrl,
    ...extra,
  };
}

function parseDashManifest(xml) {
  if (!xml) return null;
  const decoded = xml.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const sets = [];
  for (const setMatch of decoded.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g)) {
    const setAttrs = setMatch[1];
    const contentType = (setAttrs.match(/contentType="([^"]+)"/) || [])[1] || null;
    const reps = [];
    for (const repMatch of setMatch[2].matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g)) {
      const attrs = repMatch[1];
      const attr = (name) => (attrs.match(new RegExp('(?:^|\\s)' + name + '="([^"]*)"')) || [])[1] || null;
      const base = (repMatch[2].match(/<BaseURL>([\s\S]*?)<\/BaseURL>/) || [])[1] || null;
      reps.push({
        id: attr('id'),
        mime_type: attr('mimeType'),
        codecs: attr('codecs'),
        bandwidth: numberOrNull(attr('bandwidth')),
        width: numberOrNull(attr('width')),
        height: numberOrNull(attr('height')),
        frame_rate: attr('frameRate'),
        content_length: numberOrNull(attr('FBContentLength')),
        direct_url: base,
      });
    }
    sets.push({ id: (setAttrs.match(/id="([^"]*)"/) || [])[1] || null, content_type: contentType, representations: reps });
  }
  const durationMatch = decoded.match(/mediaPresentationDuration="PT([0-9.]+)S"/);
  return {
    duration_seconds: durationMatch ? Number(durationMatch[1]) : null,
    adaptation_sets: sets,
    audio: sets.filter((s) => s.content_type === 'audio').flatMap((s) => s.representations),
    video: sets.filter((s) => s.content_type === 'video').flatMap((s) => s.representations),
  };
}

// ------------------------------------------------- /api/convert (url input)

function normalizeConvertItem(item, index) {
  const meta = item.meta || {};
  const manifest = parseDashManifest(meta.dash_manifest);
  const extra = index === null ? {} : { item_index: index };
  const media = (item.url || []).map((e) => mediaEntry(e, 'api.url', extra)).filter(Boolean);
  for (const [field, origin] of [['thumb', 'api.thumb'], ['sd', 'api.sd'], ['hd', 'api.hd']]) {
    const entry = mediaEntry(item[field], origin, extra);
    // an image slide's thumb points at the same file as its url entry, so skip the duplicate
    if (entry && !media.some((m) => sameFile(m.direct_url, entry.direct_url))) media.push(entry);
  }
  for (const rep of manifest ? manifest.audio : []) {
    media.push({
      kind: 'audio',
      label: rep.codecs || 'audio',
      type: rep.mime_type,
      ext: rep.mime_type === 'audio/mp4' ? 'm4a' : null,
      quality: null,
      width: rep.width,
      height: rep.height,
      bytes: rep.content_length,
      filename: null,
      origin: 'dash.audio',
      proxy_url: null,
      direct_url: rep.direct_url,
      ...extra,
    });
  }
  return { index, media, manifest, meta };
}

/*
 * /api/convert answers with an object for a single media item and with an array for a carousel
 * (one entry per slide, each carrying its own url/meta/thumb), so both are normalised here.
 */
function normalizeConvert(raw, input) {
  const items = Array.isArray(raw) ? raw : [raw];
  const single = !Array.isArray(raw);
  const parts = items.map((it, i) => normalizeConvertItem(it, single ? null : i + 1));
  const meta = parts[0].meta || {};
  const media = parts.flatMap((p) => p.media);
  const takenAt = numberOrNull(meta.taken_at);
  const username = meta.username || null;
  return {
    kind: single ? 'media' : 'album',
    input,
    source: {
      url: meta.source || input.url,
      shortcode: meta.shortcode || input.shortcode || null,
      hosting: ((single ? raw.hosting : items[0] && items[0].hosting) || null),
    },
    author: {
      username,
      profile_url: username ? `https://www.instagram.com/${username}/` : null,
    },
    description: {
      title: meta.title || '',
      caption: meta.caption ?? meta.description ?? null,
    },
    stats: {
      like_count: numberOrNull(meta.like_count),
      comment_count: numberOrNull(meta.comment_count),
      share_count: numberOrNull(meta.share_count),
      play_count: numberOrNull(meta.play_count ?? meta.view_count),
      taken_at: takenAt,
      taken_at_iso: isoTimestamp(takenAt),
    },
    item_count: items.length,
    media,
    items: single ? undefined : parts.map((p) => ({ index: p.index, media: p.media })),
    dash_manifest: parts.map((p) => p.manifest).find(Boolean) || null,
  };
}

// ------------------------------------------------- /api/v1/instagram (profile input)

// media_versions / image_versions2 of an Instagram media node, or of a carousel child.
function normalizeIgMediaObject(node) {
  const media = [];
  const seenVideo = new Set();
  for (const v of node.video_versions || []) {
    const dims = `${v.width}x${v.height}`;
    if (!includeAllVersions && seenVideo.has(dims)) continue;
    seenVideo.add(dims);
    media.push({
      kind: 'video',
      label: v.height ? (v.width ? `${v.width}x${v.height}` : `${v.height}p`) : null,
      type: 'mp4',
      ext: 'mp4',
      quality: numberOrNull(v.height),
      width: numberOrNull(v.width),
      height: numberOrNull(v.height),
      bytes: null,
      filename: null,
      origin: 'ig.video_versions',
      proxy_url: null,
      direct_url: v.url || null,
    });
  }
  const candidates = (node.image_versions2 && node.image_versions2.candidates) || [];
  const chosen = includeAllVersions ? candidates : candidates.slice(0, 1);
  chosen.forEach((c, i) => {
    const ext = extFromUrl(c.url) || 'jpg';
    media.push({
      kind: 'image',
      label: c.width && c.height ? `${c.width}x${c.height}` : null,
      type: ext,
      ext,
      quality: null,
      width: numberOrNull(c.width),
      height: numberOrNull(c.height),
      bytes: null,
      filename: null,
      origin: `ig.image_versions2[${i}]`,
      proxy_url: null,
      direct_url: c.url || null,
      variant_count: candidates.length,
      ...(includeAllVersions ? {} : { note: candidates.length > 1 ? `${candidates.length} Instagram sizes available, --all-versions lists them` : undefined }),
    });
  });
  return media;
}

// clips_metadata carries the reel's soundtrack: licensed music_info or original_sound_info.
function normalizeMusic(node) {
  const cm = node.clips_metadata || {};
  const licensed = cm.music_info && cm.music_info.music_asset_info;
  const original = cm.original_sound_info;
  if (licensed) {
    return {
      source: 'music_info',
      audio_type: cm.audio_type ?? null,
      title: licensed.title ?? null,
      artist: licensed.display_artist ?? null,
      audio_id: licensed.audio_asset_id ?? null,
      is_explicit: licensed.is_explicit ?? null,
    };
  }
  if (original) {
    return {
      source: 'original_sound_info',
      audio_type: cm.audio_type ?? null,
      title: original.original_audio_title ?? null,
      artist: (original.ig_artist && original.ig_artist.username) || null,
      audio_id: original.audio_asset_id ?? null,
      is_explicit: original.is_explicit ?? null,
    };
  }
  return cm.audio_type ? { source: 'clips_metadata', audio_type: cm.audio_type, title: null, artist: null, audio_id: null, is_explicit: null } : null;
}

function normalizePostNode(node) {
  const code = node.code || node.shortcode || null;
  const children = Array.isArray(node.carousel_media) ? node.carousel_media : null;
  const carousel = children ? children.map((child, i) => ({ index: i + 1, media: normalizeIgMediaObject(child).map((m) => ({ ...m, item_index: i + 1 })) })) : null;
  // a carousel container repeats its first slide in the parent node, so only children carry media
  const media = children ? carousel.flatMap((c) => c.media) : normalizeIgMediaObject(node);
  const takenAt = numberOrNull(node.taken_at);
  const owner = node.owner || {};
  return {
    shortcode: code,
    url: code ? `https://www.instagram.com/p/${code}/` : null,
    product_type: node.product_type ?? null,
    media_type: node.media_type ?? null,
    is_video: node.media_type === 2 || media.some((m) => m.kind === 'video'),
    carousel_count: numberOrNull(node.carousel_media_count) ?? (children ? children.length : null),
    author: {
      username: owner.username ?? (node.user && node.user.username) ?? null,
      pk: owner.pk ?? null,
      full_name: owner.full_name ?? null,
    },
    description: {
      // caption arrives either as a string or as {text, pk, created_at}
      caption: (node.caption && typeof node.caption === 'object') ? (node.caption.text ?? null) : (node.caption ?? null),
      caption_pk: (node.caption && typeof node.caption === 'object') ? node.caption.pk ?? null : null,
      title: node.title ?? null,
      accessibility_caption: node.accessibility_caption ?? null,
    },
    stats: {
      like_count: numberOrNull(node.like_count),
      comment_count: numberOrNull(node.comment_count),
      view_count: numberOrNull(node.view_count),
      fb_like_count: numberOrNull(node.fb_like_count),
      taken_at: takenAt,
      taken_at_iso: isoTimestamp(takenAt),
    },
    music: normalizeMusic(node),
    location: node.location ? { name: node.location.name ?? null, lat: numberOrNull(node.location.lat), lng: numberOrNull(node.location.lng) } : null,
    media,
    carousel,
  };
}

function normalizeUser(user) {
  if (!user || typeof user !== 'object') return user ?? null;
  return {
    pk: user.pk ?? user.pk_id ?? user.id ?? null,
    username: user.username ?? null,
    full_name: user.full_name ?? null,
    biography: user.biography ?? null,
    external_url: user.external_url || null,
    category: user.category ?? null,
    is_private: user.is_private ?? null,
    is_verified: user.is_verified ?? null,
    is_business: user.is_business ?? user.is_professional_account ?? null,
    follower_count: numberOrNull(user.follower_count),
    following_count: numberOrNull(user.following_count),
    media_count: numberOrNull(user.media_count),
    total_clips_count: numberOrNull(user.total_clips_count),
    profile_pic_url: user.profile_pic_url || null,
    profile_pic_url_hd: (user.hd_profile_pic_url_info && user.hd_profile_pic_url_info.url) || user.profile_pic_url_hd || null,
  };
}

function normalizePostsPayload(payload) {
  const result = (payload && payload.result !== undefined) ? payload.result : payload;
  const edges = (result && result.edges) || [];
  return {
    count: edges.length,
    page_info: result ? result.page_info ?? null : null,
    items: edges.map((edge) => normalizePostNode(edge.node || edge)),
  };
}

function normalizeStoriesPayload(payload) {
  const result = (payload && payload.result !== undefined) ? payload.result : payload;
  const items = Array.isArray(result) ? result : (result && result.edges ? result.edges.map((e) => e.node) : []);
  return {
    count: items.length,
    items: items.map((item) => ({
      pk: item.pk ?? item.id ?? null,
      media_type: item.media_type ?? null,
      taken_at: numberOrNull(item.taken_at ?? item.expiring_at),
      taken_at_iso: isoTimestamp(item.taken_at ?? item.expiring_at),
      media: normalizeIgMediaObject(item),
    })),
  };
}

function normalizeHighlightsPayload(payload) {
  const result = (payload && payload.result !== undefined) ? payload.result : payload;
  const items = Array.isArray(result) ? result : [];
  return {
    count: items.length,
    items: items.map((item) => ({
      id: item.id ?? item.pk ?? null,
      title: item.title ?? null,
      cover: normalizeIgMediaObject(item.cover_media || {})[0] || null,
      count: numberOrNull(item.media_count),
    })),
  };
}

// flatten normalised media into downloadable entries with stable filenames
function collectDownloads(result, opts) {
  const flat = [];
  const seenFiles = new Set();
  const push = (media, prefix) => {
    media.forEach((m, i) => {
      if (!m.direct_url && !m.proxy_url) return;
      const tag = m.item_index != null ? `slide${m.item_index}` : `main${i + 1}`;
      const filename = `${prefix}_${tag}.${m.ext || 'bin'}`;
      // thumbnails of an image slide resolve to the same file as the slide itself
      if (seenFiles.has(filename) || flat.some((f) => sameFile(f.direct_url, m.direct_url))) return;
      seenFiles.add(filename);
      flat.push({ ...m, filename });
    });
  };
  if (result.posts && result.posts.items) {
    for (const post of result.posts.items) push(post.media, post.shortcode || 'post');
  }
  if (result.stories && result.stories.items) {
    result.stories.items.forEach((s, i) => push(s.media, `story${s.pk || i + 1}`));
  }
  if (result.media) push(result.media, (result.source && result.source.shortcode) || 'media');
  return flat;
}

function errorReport(status, json) {
  const code = json && json.code;
  // the hub also reports refusals inside HTTP 200 bodies: {"success":false,"response_type":"link not found"}
  if (json && json.success === false) {
    return {
      code: String(json.response_type || json.code || 'REQUEST_FAILED').toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
      message: json.message || json.response_type || 'the backend refused this link',
      response: json,
    };
  }
  if (status === 422 && code === 'CAPTCHA_REQUIRED') {
    return {
      code,
      message: 'fastdl.app answered with a Turnstile challenge. The browser solver in solver/ handles ' +
        'it automatically (see --solve-timeout, --no-solve). Without it, pass a token from your own ' +
        'browser with --turnstile <token>, or a ready wh-cf-token with --token <wh-cf-token>.',
      challenge: json.challenge || null,
    };
  }
  if (status === 401 || code === 'REQUEST_SIGNATURE_MISSING_REQUIRED_PARAMETERS' || code === 'REQUEST_SIGNATURE_INVALID') {
    return { code: code || 'REQUEST_SIGNATURE_INVALID', message: 'the API rejected the request signature; rerun with --refresh-key to re-derive it from the site', response: json };
  }
  return { code: code || null, message: (json && (json.message || json.info || json.error)) || `HTTP ${status}`, response: json };
}

// ---------------------------------------------------------------- downloads

/*
 * Instagram's CDN hosts (scontent-*.cdninstagram.com) stall the connection Node's global fetch
 * opens from this machine while plain IPv4 TLS works, so media is pulled through node:https
 * with family forced to 4. Redirects are followed manually because https.get does not.
 */
function requestBuffer(url, headers, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { family: 4, headers }, (res) => {
      const location = res.headers.location;
      if (location && res.statusCode >= 300 && res.statusCode < 400 && redirects > 0) {
        res.resume();
        resolve(requestBuffer(new URL(location, url).toString(), headers, redirects - 1));
        return;
      }
      if (res.statusCode >= 400) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout after 60s')));
  });
}

async function downloadAll(media, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const item of media) {
    // direct CDN first (fast), signed proxy second (survives CDN URL expiry)
    const sources = [item.direct_url, item.proxy_url].filter(Boolean);
    if (!sources.length) continue;
    const name = item.filename || `${(item.label || item.kind || 'media').toString().replace(/[^\w.-]+/g, '_')}.${item.ext || 'bin'}`;
    const target = path.join(dir, name);
    let lastError = null;
    let done = false;
    for (const src of sources) {
      try {
        const res = await requestBuffer(src, { 'User-Agent': UA, Referer: SITE + '/' });
        fs.writeFileSync(target, res.body);
        saved.push({ file: target, bytes: res.body.length, source: src === item.direct_url ? 'direct' : 'proxy' });
        done = true;
        break;
      } catch (err) {
        lastError = err.message;
      }
    }
    if (!done) saved.push({ file: target, error: lastError });
  }
  return saved;
}

// ---------------------------------------------------------------- cli

function parseArgs(argv) {
  const opts = { positionals: [], download: false, delay: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--json' || a === '--compact') opts.compact = true;
    else if (a === '--raw') opts.raw = true;
    else if (a === '--download') { opts.download = true; opts.downloadDir = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : './downloads'; }
    else if (a === '--delay') opts.delay = Number(argv[++i]);
    else if (a === '--token') opts.token = argv[++i];
    else if (a === '--turnstile') opts.cfToken = argv[++i];
    else if (a === '--key') opts.key = argv[++i];
    else if (a === '--refresh-key') opts.refreshKey = true;
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '--pages') opts.pages = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--no-solve') opts.solve = false;
    else if (a === '--no-browser') opts.browserFallback = false;
    else if (a === '--h1') opts.forceH1 = true;
    else if (a === '--all-versions') opts.allVersions = true;
    else if (a === '--solve-timeout') opts.solveTimeout = Number(argv[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts.positionals.push(a);
  }
  return opts;
}

const HELP = `igdownload.js <instagram-url | username> [more inputs...] [options]

  --json            compact single-line JSON (default is 2-space pretty)
  --out FILE        also write the JSON result to FILE
  --download [DIR]  save every downloadable media item (default ./downloads)
  --delay SECONDS   pause between inputs (default 1)
  --raw             include the untouched API payload
  --pages N         profile mode: how many post pages to walk (12 posts per page)
  --all-versions    keep every Instagram image size instead of only the largest
  --token T         wh-cf-token for the captcha gate
  --turnstile T     Turnstile token, exchanged for a wh-cf-token via /api/cf
  --no-solve        never open a browser; report the captcha challenge instead
  --no-browser      keep the solver from replaying requests inside a browser page
  --h1              force HTTP/1.1 (raises the captcha challenge on purpose, for testing)
  --solve-timeout MS  how long the browser may take to solve a Turnstile challenge
  --refresh-key     re-derive the request signing key from fastdl.app
  --key HEX         override the signing key
  --timeout MS      per-request timeout
`;

// failures land in the output next to the successes, matching the other clients in this collection
function failure(input, out) {
  const err = errorReport(out.status, out.json);
  const payload = { source: 'instagram', ok: false, url: input.url, error: err.message, code: err.code || `HTTP_${out.status}` };
  if (err.challenge) payload.challenge = err.challenge;
  process.stderr.write(`[${input.url}] ${payload.code}: ${err.message}\n`);
  return payload;
}

async function extractMedia(input, opts, call) {
  const pathname = input.kind === 'story' ? '/api/v1/instagram/story' : '/api/convert';
  const body = input.kind === 'story' ? { url: input.url } : { target_url: input.url };
  let out = await call(pathname, body);
  if (out.status === 401 && !opts.refreshKey) {
    signKey = Buffer.from(await refreshKey(), 'hex');
    writeCache({ keyHex: signKey.toString('hex') });
    out = await call(pathname, body);
  }
  // the story route is captcha-gated harder than convert, so retry a story link as a normal post
  if (input.kind === 'story' && out.status !== 200) out = await call('/api/convert', { target_url: input.url });
  if (out.status !== 200 || (out.json && (out.json.code || out.json.success === false))) return failure(input, out);
  const result = { ok: true, ...normalizeConvert(out.json, input) };
  if (!result.media.length) {
    // a 200 with nothing extractable: private, deleted or region locked post
    return failure(input, { status: out.status, json: { success: false, response_type: 'no media returned', message: 'the response carried no downloadable media (private, deleted or region locked post?)' } });
  }
  if (opts.raw) result.raw = out.json;
  return result;
}

async function extractProfile(input, opts, call) {
  const userInfo = await call('/api/v1/instagram/userInfo', { username: input.username });
  if (userInfo.status !== 200) return failure(input, userInfo);

  const userInfoResult = userInfo.json.result;
  const rawUser = Array.isArray(userInfoResult) ? (userInfoResult[0] || {}).user : (userInfoResult && userInfoResult.user) || userInfoResult;
  const profile = normalizeUser(rawUser);

  // walk the post pages: the endpoint takes the previous page_info.end_cursor as maxId
  const items = [];
  const postPayloads = [];
  let pageInfo = null;
  let postsError = null;
  let maxId = '';
  for (let page = 0; page < (opts.pages || 1); page++) {
    const posts = await call('/api/v1/instagram/posts', { username: input.username, maxId });
    postPayloads.push(posts.json);
    if (posts.status !== 200) { postsError = errorReport(posts.status, posts.json); break; }
    const normalised = normalizePostsPayload(posts.json);
    items.push(...normalised.items);
    pageInfo = normalised.page_info;
    const cursor = pageInfo && pageInfo.end_cursor && pageInfo.end_cursor !== 'None' ? pageInfo.end_cursor : null;
    if (!cursor || !pageInfo.has_next_page) break;
    maxId = cursor;
  }

  const stories = await call('/api/v1/instagram/stories', { username: input.username });
  const highlights = profile && profile.pk ? await call('/api/v1/instagram/highlights', { userId: String(profile.pk) }) : null;

  const result = {
    ok: true,
    kind: 'profile',
    input,
    profile,
    posts: postsError ? { unavailable: postsError } : { count: items.length, page_info: pageInfo, items },
    stories: stories.status === 200 ? normalizeStoriesPayload(stories.json) : { unavailable: errorReport(stories.status, stories.json) },
    highlights: highlights ? (highlights.status === 200 ? normalizeHighlightsPayload(highlights.json) : { unavailable: errorReport(highlights.status, highlights.json) }) : null,
  };
  if (opts.raw) result.raw = { userInfo: userInfo.json, posts: postPayloads, stories: stories.json, highlights: highlights ? highlights.json : null };
  return result;
}

async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help || opts.positionals.length === 0) {
    process.stderr.write(HELP);
    return opts.help ? 0 : 1;
  }
  if (opts.key) signKey = Buffer.from(opts.key, 'hex');
  if (opts.allVersions) includeAllVersions = true;
  if (opts.cfToken) await exchangeTurnstile(opts.cfToken);
  if (opts.refreshKey) {
    const key = await refreshKey();
    signKey = Buffer.from(key, 'hex');
    writeCache({ keyHex: key });
    process.stderr.write(`signing key refreshed: ${key}\n`);
  } else if (!opts.key && readCache().keyHex) {
    signKey = Buffer.from(readCache().keyHex, 'hex');
  }

  const call = (pathname, body) => api(pathname, body, {
    token: opts.token,
    whCfToken: opts.whCfToken,
    timeout: opts.timeout,
    solve: opts.solve,
    solveTimeout: opts.solveTimeout,
    forceH1: opts.forceH1,
    browserFallback: opts.browserFallback,
  });

  const results = [];
  let failures = 0;
  for (const [index, value] of opts.positionals.entries()) {
    if (index) await new Promise((resolve) => setTimeout(resolve, opts.delay * 1000));
    let input;
    try {
      input = parseInput(value);
    } catch (err) {
      failures++;
      results.push({ source: 'instagram', ok: false, url: String(value), error: err.message, code: 'INVALID_INPUT' });
      continue;
    }
    const result = input.kind === 'profile' ? await extractProfile(input, opts, call) : await extractMedia(input, opts, call);
    if (result.ok === false) failures++;
    if (opts.download && result.ok) result.downloads = await downloadAll(collectDownloads(result), opts.downloadDir);
    results.push(result);
  }

  const payload = results.length === 1 ? results[0] : results;
  const text = JSON.stringify(payload, null, opts.compact ? 0 : 2);
  process.stdout.write(text + '\n');
  if (opts.out) fs.writeFileSync(opts.out, text + '\n');
  return failures ? 1 : 0;
}

module.exports = {
  signBody, stableStringify, parseInput, parseDashManifest, mediaEntry, downloadAll, refreshKey, api, solveCaptcha,
  normalizeConvert, normalizePostNode, normalizeUser, normalizePostsPayload, normalizeStoriesPayload, normalizeHighlightsPayload,
  collectDownloads, errorReport, http2Post, browserFetch,
  KEY_HEX, DEFAULT_TURNSTILE_SITEKEY,
};

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  });
}
