#!/usr/bin/env node
'use strict';
/*
 * snaptik.js: snaptik.app TikTok downloader client (video, HD, carousel
 * images, slideshow video, audio) plus post metadata from TikTok's own page
 * data (likes, comments, shares, plays, saves, author stats, music).
 *
 * Plain HTTPS, no dependencies, Node >= 18 (global fetch + WebCrypto).
 * Verified 2026-09-11 against snaptik.app/en3 and /js/core.min.js.
 *
 * Flow:
 *   1. POST /api/token -> {id, p}; p is base64(iv || AES-256-CBC(puzzle)).
 *      Key = SHA256("sn4pt1k_v3r1fy2026:" + id). Solve the puzzle and build
 *      the X-Verify header "id:answer:_e:_h".
 *   2. GET /api/extract?url=<tiktok url> with X-Verify -> type, downloadUrl,
 *      hdDownloadUrl, stats, author, images[].
 *   3. HD: GET /api/hd?token=... with a fresh X-Verify -> {url}. Without
 *      X-Verify the endpoint answers 403 {"error":true}.
 *   4. Enrichment: fetch the post page with an iPhone UA and parse the
 *      <script id="api-data"> blob for exact stats (likeCount = diggCount,
 *      collectCount = saves), author stats and music.playUrl (the mp3).
 *
 * Tokens: the X-Verify pass is a per-session challenge, not an API key. It
 * expires after 300 seconds (_e, unix seconds) and is reusable inside that
 * window. This client solves a fresh one for every extract attempt and every
 * HD call, so a stale or throttled pass is never reused. Limit-like failures
 * (fresh 403s, rate messages) retry with exponential backoff.
 *
 * What snaptik does not expose:
 *   - No likeCount and no audio URL: both come from the TikTok enrichment.
 *   - hdDownloadUrl is a path (/api/hd?token=...), not a media URL.
 *   - Carousel downloadUrl is a rendered slideshow video, not an image.
 *   - TikTok playAddr / bitrateInfo URLs are IP and cookie bound and answer
 *     403 outside the requesting session; they are reported under
 *     meta.sessionBound instead of being offered as downloads.
 *
 * Usage:
 *   node snaptik.js <tiktok-url> [<url> ...] [options]
 * Options:
 *   --json            single-line JSON (default: 2-space pretty)
 *   --download [dir]  also save media to dir (default: downloads)
 *   --no-hd           skip HD resolution (saves one request)
 *   --no-enrich       skip the TikTok metadata fetch
 *   --delay SECONDS   pause between multiple URLs
 *
 * Output: JSON on stdout, progress and errors on stderr.
 */

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const BASE = 'https://snaptik.app';
const HOME = BASE + '/en3';
const SECRET = 'sn4pt1k_v3r1fy2026'; // reassembled in core.min.js from obfuscated parts
const PIPED = process.env.SNAPTIK_QUIET !== '1';

class SnaptikError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => {
  if (PIPED) console.error(...a);
};

async function http(url, opts = {}) {
  const headers = {
    'User-Agent': opts.ua || DESKTOP_UA,
    Accept: opts.accept || 'application/json, text/html, */*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  let text = '';
  try {
    text = await res.text();
  } catch (_) {
    /* unreadable body; callers handle empty text */
  }
  return { status: res.status, headers: res.headers, text, url: res.url };
}

// challenge: /api/token -> X-Verify header

const encoder = new TextEncoder();

async function solveChallenge(id, payloadB64) {
  const raw = Buffer.from(payloadB64, 'base64');
  if (raw.length < 32) throw new SnaptikError('challenge payload too short', 'CHALLENGE');
  const iv = raw.subarray(0, 16);
  const ct = raw.subarray(16);

  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${SECRET}:${id}`));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-CBC' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ct);

  const puzzle = JSON.parse(new TextDecoder().decode(plain));
  const type = puzzle.t;
  delete puzzle.t;
  const _e = puzzle._e;
  const _h = puzzle._h;
  delete puzzle._e;
  delete puzzle._h;

  let answer;
  switch (type) {
    case 'b': answer = (puzzle.a ^ puzzle.b) >> puzzle.s & 255; break;
    case 'r': answer = puzzle.n.reduce((x, y) => x + y, 0) * 2 + 1; break;
    case 'c': answer = puzzle.w.charCodeAt(puzzle.i) * puzzle.m; break;
    case 'm': answer = ((puzzle.a + puzzle.b) % 100) * puzzle.c; break;
    case 'n': answer = puzzle.a * puzzle.b + puzzle.b * puzzle.c + puzzle.c * puzzle.a - puzzle.a; break;
    default: throw new SnaptikError(`unknown challenge type "${type}"`, 'CHALLENGE');
  }
  return `${id}:${answer}:${_e}:${_h}`;
}

async function getToken() {
  const { status, text } = await http(BASE + '/api/token', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' },
  });
  if (status !== 200) throw new SnaptikError(`token endpoint ${status}`, 'HTTP');
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    throw new SnaptikError('token endpoint returned non-JSON', 'TOKEN');
  }
  if (!body.id || !body.p) throw new SnaptikError('token response missing id/p', 'TOKEN');
  return solveChallenge(body.id, body.p);
}

// /api/extract

async function extractRaw(inputUrl, { tries = 4 } = {}) {
  let lastErr;
  // Retry connection/HTTP failures, challenge failures, and site errors that
  // smell like rate limiting. Each attempt solves a fresh token, so expiry
  // errors heal on retry.
  const transient = (e) =>
    !e.code ||
    ['HTTP', 'TOKEN', 'CHALLENGE', 'EMPTY', 'LIMIT'].includes(e.code) ||
    /limit|too many|rate|forbidden|expired|token/i.test(e.message);
  for (let i = 0; i < tries; i++) {
    try {
      // The site itself retries once on 403 with a freshly solved challenge.
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await http(
          `${BASE}/api/extract?url=${encodeURIComponent(inputUrl)}`,
          { headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-Verify': await getToken() } },
        );
        if (res.status === 403 && attempt === 0) continue;
        let json;
        try {
          json = JSON.parse(res.text);
        } catch (_) {
          throw new SnaptikError(`extract ${res.status}: unparseable body`, 'PARSE');
        }
        if (json.error) throw new SnaptikError(json.message || 'extract error', 'SITE');
        const data = json.data || json;
        if (!data || !data.id) throw new SnaptikError('extract returned no item', 'EMPTY');
        return data;
      }
      throw new SnaptikError('extract kept answering 403', 'HTTP');
    } catch (e) {
      lastErr = e;
      if (!transient(e)) throw e;
      if (i === tries - 1) break;
      log(`  retry ${i + 1}/${tries - 1} after: ${e.message}`);
      await sleep(2000 * (i + 1));
    }
  }
  throw lastErr;
}

async function resolveHd(hdPath) {
  const res = await http(BASE + hdPath, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'X-Verify': await getToken(),
      Referer: HOME,
    },
  });
  let json;
  try {
    json = JSON.parse(res.text);
  } catch (_) {
    throw new SnaptikError(`hd ${res.status}: unparseable body`, 'PARSE');
  }
  if (res.status !== 200 || json.error || !json.url) {
    const code = /limit|too many|rate|expired/i.test(json.message || '') ? 'LIMIT' : 'HD';
    throw new SnaptikError(json.message || `hd ${res.status}`, code);
  }
  return json.url;
}

// TikTok enrichment

async function enrich(tiktokUrl) {
  let res;
  try {
    res = await http(tiktokUrl, { ua: MOBILE_UA, accept: 'text/html,*/*;q=0.8' });
  } catch (e) {
    return { ok: false, reason: `tiktok fetch failed: ${e.message}` };
  }
  if (res.status !== 200) return { ok: false, reason: `tiktok page ${res.status}` };
  const html = res.text;
  if (html.length < 20000 || /Please wait/.test(html)) {
    return { ok: false, reason: 'tiktok WAF challenge, hydration not readable' };
  }

  let item = null;
  const apiData = html.match(/<script id="api-data" type="application\/json">\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (apiData) {
    try {
      const d = JSON.parse(apiData[1]);
      item = d?.videoDetail?.itemInfo?.itemStruct || null;
    } catch (_) {
      item = null;
    }
  }
  if (!item) {
    const univ = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (univ) {
      try {
        const scope = JSON.parse(univ[1]).__DEFAULT_SCOPE__ || {};
        item =
          scope['webapp.video-detail']?.itemInfo?.itemStruct ||
          scope['webapp.photo-detail']?.itemInfo?.itemStruct ||
          null;
      } catch (_) {
        item = null;
      }
    }
  }
  if (!item) return { ok: false, reason: 'no item data in tiktok page' };

  const num = (x) => (x === undefined || x === null ? null : parseInt(x, 10) || 0);
  const stats = item.stats || {};
  const author = item.author || {};
  const authorStats = item.authorStats || {};
  const music = item.music || {};
  const video = item.video || {};

  const out = {
    ok: true,
    id: item.id || null,
    description: item.desc || null,
    createdAt: item.createTime ? new Date(num(item.createTime) * 1000).toISOString() : null,
    stats: {
      likes: num(stats.diggCount),
      comments: num(stats.commentCount),
      shares: num(stats.shareCount),
      plays: num(stats.playCount),
      saves: num(stats.collectCount),
    },
    author: {
      id: author.id || null,
      username: author.uniqueId || null,
      nickname: author.nickname || null,
      signature: author.signature || null,
      verified: author.verified === true,
      avatar: author.avatarLarger || author.avatarMedium || author.avatarThumb || null,
    },
    authorStats: {
      followers: num(authorStats.followerCount),
      following: num(authorStats.followingCount),
      totalLikes: num(authorStats.heartCount),
      videos: num(authorStats.videoCount),
    },
    music: {
      id: music.id || null,
      title: music.title || null,
      author: music.authorName || null,
      original: music.original === true,
      album: music.album || null,
      duration: num(music.duration),
      playUrl: music.playUrl || null,
      cover: music.coverLarge || music.coverMedium || null,
    },
    video: {
      duration: num(video.duration),
      // Photo posts carry a stub video object with zero dimensions.
      width: num(video.width) > 0 ? num(video.width) : null,
      height: num(video.height) > 0 ? num(video.height) : null,
      ratio: video.ratio || null,
      size: num(video.size) > 0 ? num(video.size) : null,
      cover: video.cover || video.originCover || null,
      dynamicCover: video.dynamicCover || null,
    },
    hashtags: (item.challenges || []).map((c) => c.title).filter(Boolean),
    // Hashtags carry type 1 in api-data, so mentions are detected by the
    // missing hashtagId, not the type code.
    mentions: (item.textExtra || [])
      .filter((t) => !t.hashtagId && (t.userUniqueId || t.userId))
      .map((t) => `@${t.userUniqueId || t.userId}`),
    location: item.locationCreated || null,
    // TikTok's own CDN URLs are IP and cookie bound; report them as
    // session-bound, not as downloads.
    sessionBound: {
      playUrl: video.playAddr || null,
      downloadUrl: video.downloadAddr || null,
      qualities: (video.bitrateInfo || [])
        .map((b) => ({
          gearName: b.GearName || null,
          bitrate: b.Bitrate || null,
          width: b.PlayAddr?.Width || null,
          height: b.PlayAddr?.Height || null,
          url: b.PlayAddr?.UrlList?.[0] || null,
        }))
        .filter((q) => q.url),
    },
  };

  const images = item.imagePost?.images || [];
  if (images.length) {
    out.slides = images.map((im, i) => {
      const urls = (im.imageURL || im.imageUrl || {}).urlList || [];
      return {
        index: i + 1,
        url: urls[0] || null,
        width: im.imageWidth || im.width || null,
        height: im.imageHeight || im.height || null,
      };
    });
    out.slidesTitle = item.imagePost?.title || null;
  }
  return out;
}

// canonical URL

async function canonicalize(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    throw new SnaptikError(`not a valid URL: ${rawUrl}`, 'BADURL');
  }
  if (!/tiktok\.com$|tiktok\.com\./i.test(url.hostname) && !/douyin\.com$/i.test(url.hostname)) {
    throw new SnaptikError(`not a tiktok/douyin link: ${rawUrl}`, 'BADURL');
  }
  // Short links (vm./vt.tiktok.com, /t/XXXX) redirect to the canonical post URL.
  if (/^(vm|vt|m)\./i.test(url.hostname) || /\/t\/[A-Za-z0-9]+/.test(url.pathname)) {
    const res = await http(rawUrl, { accept: 'text/html,*/*;q=0.8' });
    if (res.url && /tiktok\.com\/@/.test(res.url)) return res.url.split('?')[0];
  }
  return rawUrl;
}

// merge

function buildResult(rawUrl, canonical, data, tiktok) {
  const tt = tiktok && tiktok.ok ? tiktok : null;
  const isCarousel = data.type === 'carousel' || data.type === 'slide' || Array.isArray(data.images);
  const ttDims = (tt && tt.slides ? tt.slides : []);
  const slides = (data.images || []).map((im, i) => ({
    index: i + 1,
    url: im.url || null,
    thumbnail: im.thumbnail || null,
    downloadUrl: im.downloadUrl || im.url || null,
    width: im.width || ttDims[i]?.width || null,
    height: im.height || ttDims[i]?.height || null,
  }));

  // Prefer TikTok's exact counters; fall back to snaptik's rounded page numbers.
  const fromSnaptik = data.stats || {};
  const stats = {
    likes: tt ? tt.stats.likes : null,
    comments: tt ? tt.stats.comments : fromSnaptik.commentCount ?? null,
    shares: tt ? tt.stats.shares : fromSnaptik.shareCount ?? null,
    plays: tt ? tt.stats.plays : fromSnaptik.playCount ?? null,
    saves: tt ? tt.stats.saves : null,
  };

  return {
    type: isCarousel ? 'carousel' : 'video',
    source: rawUrl,
    canonicalUrl: canonical,
    id: data.id || null,
    title: data.title || (tt ? tt.description : null) || null,
    thumbnail: data.thumbnail || (tt ? tt.video.cover : null) || null,
    downloads: {
      video: isCarousel ? null : data.downloadUrl || null,
      hd: isCarousel ? null : data.hdDownloadUrl ? data.__hd || null : null,
      hdEndpoint: isCarousel || !data.hdDownloadUrl ? null : data.hdDownloadUrl,
      audio: tt ? tt.music.playUrl : null,
      cover: data.thumbnail || null,
      slides: isCarousel ? slides : [],
      slidesAsVideo: isCarousel ? data.downloadUrl || null : null,
    },
    stats,
    statsSource: tt ? 'tiktok:api-data' : 'snaptik:extract',
    author: {
      name: tt ? tt.author.nickname : data.author?.name || null,
      username: tt ? tt.author.username : data.author?.username || null,
      avatar: tt ? tt.author.avatar : data.author?.avatar || null,
      verified: tt ? tt.author.verified : null,
      signature: tt ? tt.author.signature : null,
      stats: tt ? tt.authorStats : null,
    },
    music: tt ? tt.music : null,
    video: {
      duration: (tt && tt.video.duration) || data.videoDuration || null,
      width: tt ? tt.video.width : null,
      height: tt ? tt.video.height : null,
      ratio: tt ? tt.video.ratio : null,
      size: tt ? tt.video.size : null,
      cover: tt ? tt.video.cover : null,
      dynamicCover: tt ? tt.video.dynamicCover : null,
    },
    meta: {
      description: tt ? tt.description : data.title || null,
      createdAt: tt ? tt.createdAt : null,
      hashtags: tt ? tt.hashtags : [],
      mentions: tt ? tt.mentions : [],
      location: tt ? tt.location : null,
      slidesTitle: tt ? tt.slidesTitle || null : null,
      snaptikType: data.type || null,
      enrichment: tt
        ? { ok: true }
        : { ok: false, reason: tiktok ? tiktok.reason : 'disabled' },
      sessionBound: tt ? tt.sessionBound : null,
    },
  };
}

async function extract(rawUrl, opts = {}) {
  const canonical = await canonicalize(rawUrl);
  if (canonical !== rawUrl) log(`resolved short link -> ${canonical}`);

  const data = await extractRaw(canonical);
  if (opts.hd !== false && data.hdDownloadUrl) {
    try {
      data.__hd = await resolveHd(data.hdDownloadUrl);
    } catch (e) {
      log(`  hd unavailable: ${e.message}`);
      data.__hd = null;
      if (e.code === 'LIMIT') await sleep(4000); // ease off before the next request
    }
  }
  const tiktok = opts.enrich === false ? { ok: false, reason: 'disabled' } : await enrich(canonical);
  return buildResult(rawUrl, canonical, data, tiktok);
}

// optional file save

function sniffExt(buf) {
  if (buf.length >= 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return '.webp';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf.subarray(0, 3).toString() === 'ID3') return '.mp3';
  if (buf.subarray(4, 8).toString() === 'ftyp') return '.mp4';
  return null;
}

async function downloadTo(url, filePath, opts = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': DESKTOP_UA, Referer: opts.referer || HOME } });
  if (!res.ok) throw new SnaptikError(`download ${res.status} for ${url.slice(0, 80)}`, 'HTTP');
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = opts.sniff ? sniffExt(buf) : null;
  const finalPath = ext && !filePath.endsWith(ext) ? filePath.replace(/\.[a-z0-9]+$/i, ext) : filePath;
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(finalPath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(finalPath, buf);
  return { path: finalPath, bytes: buf.length };
}

async function saveDownloads(result, dir) {
  const saved = {};
  const id = String(result.id || 'post').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40);
  const d = result.downloads;
  const jobs = [
    ['video', d.video, `${dir}/video_${id}.mp4`],
    ['hd', d.hd, `${dir}/video_${id}_hd.mp4`],
    ['audio', d.audio, `${dir}/audio_${id}.mp3`],
    ['slidesAsVideo', d.slidesAsVideo, `${dir}/slides_${id}.mp4`],
  ];
  for (const [key, url, path] of jobs) {
    if (!url) continue;
    try {
      saved[key] = await downloadTo(url, path);
    } catch (e) {
      saved[key] = { error: e.message };
    }
  }
  for (const s of d.slides || []) {
    const url = s.downloadUrl || s.url;
    if (!url) continue;
    try {
      saved[`slide_${s.index}`] = await downloadTo(url, `${dir}/slide_${id}_${s.index}.img`, { sniff: true });
    } catch (e) {
      saved[`slide_${s.index}`] = { error: e.message };
    }
  }
  return saved;
}

// CLI

function usage() {
  return [
    'usage: node snaptik.js <tiktok-url> [<url> ...] [options]',
    '',
    'options:',
    '  --json            single-line JSON (default: 2-space pretty)',
    '  --download [dir]  also save media files (default: downloads)',
    '  --no-hd           skip HD resolution',
    '  --no-enrich       skip the TikTok metadata fetch',
    '  --delay SECONDS   pause between multiple URLs',
    '',
    'prints one JSON object per URL (array when given several), stdout only.',
  ].join('\n');
}

async function main(argv) {
  const opts = { enrich: true, hd: true };
  const urls = [];
  let pretty = true;
  let downloadDir = null;
  let delay = 0;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') pretty = false;
    else if (a === '--no-hd') opts.hd = false;
    else if (a === '--no-enrich') opts.enrich = false;
    else if (a === '--delay') delay = parseFloat(argv[++i]) || 0;
    else if (a === '--download') {
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

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    log(`[${i + 1}/${urls.length}] ${urls[i]}`);
    try {
      const r = await extract(urls[i], opts);
      if (downloadDir) r.saved = await saveDownloads(r, downloadDir);
      results.push(r);
      log(
        `  ok: ${r.type}, stats via ${r.statsSource}` +
          (r.downloads.video ? ', video' : '') +
          (r.downloads.hd ? ', hd' : '') +
          (r.downloads.audio ? ', audio' : '') +
          (r.downloads.slides.length ? `, ${r.downloads.slides.length} slides` : ''),
      );
    } catch (e) {
      log(`  error: ${e.message}`);
      results.push({ source: urls[i], error: e.message, code: e.code || null });
    }
    if (i < urls.length - 1 && delay) await sleep(delay * 1000);
  }

  const payload = results.length === 1 ? results[0] : results;
  console.log(JSON.stringify(payload, null, pretty ? 2 : 0));
  process.exit(results.some((r) => r.error) ? 1 : 0);
}

module.exports = { extract, enrich, extractRaw, getToken, solveChallenge, resolveHd, canonicalize, downloadTo };

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.log(JSON.stringify({ error: e.message, code: e.code || null }, null, 2));
    process.exit(1);
  });
}
