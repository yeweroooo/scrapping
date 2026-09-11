#!/usr/bin/env node
'use strict';
/*
 * sstik.js: ssstik.io TikTok downloader client (video, HD, mp3, photo
 * carousels) plus full post metadata from TikTok's own page data.
 *
 * Plain HTTPS, no dependencies, Node >= 18 (uses global fetch).
 * Verified 2026-09-11 against ssstik.io /abc flow and TikTok api-data JSON.
 *
 * Flow:
 *   1. GET ssstik.io/ -> s_tt token
 *   2. POST /abc?url=dl  {id, locale, tt} -> result HTML + hx-trigger header
 *      (ssssuccess_videoandmp3 | ssssuccess_slides | ssslimitexceed)
 *   3. HD: POST the hd_download data-directurl path {tt} -> hx-redirect header
 *   4. Enrichment: fetch the TikTok page with an iPhone UA, parse the
 *      <script id="api-data"> hydration JSON (exact stats, author, music).
 */

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const BASE = 'https://ssstik.io';
const SLIDES_VIDEO_ENDPOINT = 'https://r.ssstik.top/b/index.sh';

class SstikError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(url, opts = {}) {
  const headers = {
    'User-Agent': opts.ua || DESKTOP_UA,
    Accept: opts.accept || 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
  let text = '';
  try {
    text = await res.text();
  } catch (_) {
    /* body not readable, fine for HEAD/empty responses */
  }
  return { status: res.status, headers: res.headers, text, res };
}

async function getToken() {
  const { status, text } = await http(BASE + '/');
  if (status !== 200) throw new SstikError(`landing page ${status}`, 'HTTP');
  const m = text.match(/s_tt\s*=\s*'([^']+)'/);
  if (!m) throw new SstikError('could not find s_tt token on landing page', 'TOKEN');
  return m[1];
}

async function submit(url, token, locale = 'en') {
  const body = new URLSearchParams({ id: url, locale, tt: token });
  const { status, headers, text } = await http(BASE + '/abc?url=dl', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'HX-Request': 'true',
      'HX-Target': 'target',
      Origin: BASE,
      Referer: BASE + '/',
    },
    body: body.toString(),
  });
  const trigger = headers.get('hx-trigger') || '';
  if (status !== 200) throw new SstikError(`convert POST ${status}`, 'HTTP');
  if (trigger === 'ssslimitexceed') throw new SstikError('rate limited (ssslimitexceed)', 'LIMIT');
  if (trigger === 'ssssuccess_videoandmp3') return { type: 'video', text };
  if (trigger === 'ssssuccess_slides') return { type: 'slides', text };
  if (text.includes('rickrolled.gif')) throw new SstikError('invalid or unsupported link', 'BADURL');
  throw new SstikError(`unexpected response (hx-trigger=${trigger || 'none'})`, 'UNKNOWN');
}

async function submitRetry(url, opts = {}) {
  const tries = opts.tries ?? 4;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await submit(url, await getToken(), opts.locale);
    } catch (e) {
      lastErr = e;
      /* transient: rate limits, connection resets, empty responses */
      const transient = e.code === undefined || ['LIMIT', 'UNKNOWN', 'HTTP', 'TOKEN'].includes(e.code);
      if (!transient) throw e;
      await sleep(2500 * 2 ** i);
    }
  }
  throw lastErr;
}

function decodeTikcdn(href) {
  /* tikcdn.io/ssstik/<type?>/<base64url payload>; the bare /ssstik/<id>?st=..&e=.. links are opaque. */
  const m = href.match(/tikcdn\.io\/ssstik\/(?:[a-z]\/)?([A-Za-z0-9_\-=]+)/);
  if (!m) return null;
  const p = m[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = p.length % 4 === 0 ? '' : '='.repeat(4 - (p.length % 4));
  try {
    const dec = Buffer.from(p + pad, 'base64').toString('utf8');
    return /^https?:\/\//.test(dec) ? dec : null;
  } catch (_) {
    return null;
  }
}

function parseVideo(html) {
  const out = {};
  const hd = html.match(/id="hd_download"\s+data-directurl="([^"]+)"/);
  if (hd) out.hdRequest = hd[1].replace(/&amp;/g, '&');

  const tt = html.match(/name="tt"\s+value="([^"]+)"/);
  out.tt = tt ? tt[1] : null;

  for (const m of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*class="([^"]*)"/g)) {
    const href = m[1];
    const cls = m[2];
    if (/without_watermark_hd/.test(cls)) continue; /* HD trigger button, not a link */
    if (/music/.test(cls) && !out.audio) out.audio = href;
    else if (/without_watermark/.test(cls) && !out.video) out.video = href;
  }

  const cover = html.match(/background-image:\s*url\(([^)]+)\)/);
  if (cover) out.cover = cover[1];

  const authorImg = html.match(/<img[^>]*class="[^"]*result_author[^"]*"[^>]*alt="([^"]*)"/);
  const h2 = html.match(/<h2[^>]*>([^<]*)<\/h2>/);
  const cap = html.match(/<p class="maintext[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  if (authorImg) out.author = authorImg[1].trim();
  if (h2 && !out.author) out.author = h2[1].trim();
  if (cap) out.caption = cap[1].replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

  /* likes / comments / shares sit in three sibling divs inside the trending block */
  const counts = {};
  const ti = html.indexOf('trending-actions');
  if (ti !== -1) {
    const block = html.slice(ti, ti + 4000);
    const nums = [...block.matchAll(/<div>\s*([\d.,]+[KMB]?)\s*<\/div>/g)].map((m) => m[1]);
    counts.likes = nums[0];
    counts.comments = nums[1];
    counts.shares = nums[2];
  }
  out.counts = counts;
  return out;
}

function parseSlides(html) {
  const out = parseVideo(html);
  out.type = 'slides';
  const data = html.match(/name="slides_data"\s+value="([^"]+)"/);
  const metaSlides = [];
  if (data) {
    try {
      const obj = JSON.parse(Buffer.from(data[1], 'base64').toString('utf8'));
      const keys = Object.keys(obj).filter((k) => /^\d+$/.test(k)).sort((a, b) => +a - +b);
      for (const k of keys) {
        const s = obj[k];
        metaSlides.push({ url: s.url, width: s.width, height: s.height });
      }
      if (obj.music) out.musicRaw = obj.music;
      if (obj.item_id) out.itemId = obj.item_id;
    } catch (_) {
      /* leave slides empty */
    }
  }
  /* per-slide tikcdn download links, in DOM order */
  const dlSlides = [...html.matchAll(/<a\b[^>]*href="(https:\/\/tikcdn\.io\/ssstik\/[^"]+)"[^>]*class="[^"]*\bslide\b[^"]*"/g)].map((m) => ({ downloadUrl: m[1] }));
  out.slides = metaSlides.map((s, i) => ({ ...s, ...(dlSlides[i] || {}) }));
  if (dlSlides.length > metaSlides.length) out.slides.push(...dlSlides.slice(metaSlides.length));
  const gen = html.match(/id="slides_generate"[^>]*hx-post="([^"]+)"/);
  if (gen) out.slidesVideoEndpoint = gen[1];
  return out;
}

async function resolveHd(requestPath, tt) {
  const body = new URLSearchParams({ tt });
  const { status, headers } = await http(BASE + requestPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'HX-Request': 'true',
      'HX-Target': 'hd_download',
      'HX-Include': '[name=tt]',
      Origin: BASE,
      Referer: BASE + '/',
    },
    body: body.toString(),
  });
  if (status !== 200) throw new SstikError(`HD POST ${status}`, 'HTTP');
  const trigger = headers.get('hx-trigger') || '';
  if (trigger === 'ssslimitexceed') throw new SstikError('rate limited on HD (ssslimitexceed)', 'LIMIT');
  const loc = headers.get('hx-redirect');
  if (!loc) throw new SstikError(`HD failed (hx-trigger=${trigger || 'none'})`, 'HD');
  return loc;
}

async function slidesAsVideo(slidesDataJson, endpoint) {
  const body = new URLSearchParams({ slides_data: slidesDataJson });
  const { status, headers } = await http(endpoint || SLIDES_VIDEO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'HX-Request': 'true',
      Origin: BASE,
      Referer: BASE + '/',
    },
    body: body.toString(),
  });
  if (status !== 200) throw new SstikError(`slides-as-video POST ${status}`, 'HTTP');
  const loc = headers.get('hx-redirect');
  if (!loc) throw new SstikError('slides-as-video returned no hx-redirect', 'SLIDESVIDEO');
  return loc;
}

async function enrich(tiktokUrl) {
  /* Exact stats, author, music. iPhone UA bypasses the WAF that desktop pages show. */
  let status, text;
  try {
    ({ status, text } = await http(tiktokUrl, { ua: MOBILE_UA }));
  } catch (e) {
    return { unavailable: `TikTok fetch failed: ${e.message}` };
  }
  if (status !== 200) return { unavailable: `TikTok page ${status}` };
  if (text.length < 20000 || /Please wait/.test(text)) {
    return { unavailable: 'TikTok WAF challenge, hydration not readable' };
  }
  let item = null;
  const apiData = text.match(/<script id="api-data" type="application\/json">\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (apiData) {
    try {
      const d = JSON.parse(apiData[1]);
      item = d?.videoDetail?.itemInfo?.itemStruct || null;
    } catch (_) {
      item = null;
    }
  }
  if (!item) {
    const univ = text.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (univ) {
      try {
        const d = JSON.parse(univ[1]);
        const scope = d.__DEFAULT_SCOPE__ || {};
        item =
          scope['webapp.video-detail']?.itemInfo?.itemStruct ||
          scope['webapp.photo-detail']?.itemInfo?.itemStruct ||
          null;
      } catch (_) {
        item = null;
      }
    }
  }
  if (!item) return { unavailable: 'no item data in TikTok page' };

  const num = (x) => (typeof x === 'number' ? x : parseInt(x, 10) || null);
  const stats = item.stats || {};
  const author = item.author || {};
  const authorStats = item.authorStats || {};
  const music = item.music || {};
  const video = item.video || {};
  const out = {
    id: item.id,
    desc: item.desc || null,
    createTime: item.createTime ? new Date(num(item.createTime) * 1000).toISOString() : null,
    url: tiktokUrl,
    stats: {
      likes: num(stats.diggCount),
      comments: num(stats.commentCount),
      shares: num(stats.shareCount),
      plays: num(stats.playCount),
      saves: num(stats.collectCount),
    },
    author: {
      uniqueId: author.uniqueId || null,
      nickname: author.nickname || null,
      signature: author.signature || null,
      avatar: author.avatarLarger || author.avatarMedium || null,
    },
    authorStats: {
      followers: num(authorStats.followerCount),
      following: num(authorStats.followingCount),
      likes: num(authorStats.heartCount),
      videos: num(authorStats.videoCount),
    },
    music: {
      id: music.id || null,
      title: music.title || null,
      author: music.authorName || null,
      duration: num(music.duration),
      playUrl: music.playUrl || null,
      cover: music.coverLarge || music.coverMedium || null,
    },
    video: {
      duration: num(video.duration) || null,
      width: num(video.width) || null,
      height: num(video.height) || null,
      cover: video.cover || video.originCover || null,
      playUrl: video.playAddr || null,
      downloadUrl: video.downloadAddr || null,
    },
    hashtags: (item.challenges || []).map((c) => c.title).filter(Boolean),
  };
  const imgPost = item.imagePost || {};
  if (imgPost.images && imgPost.images.length) {
    out.slides = imgPost.images.map((im) => {
      const urls = (im.imageURL || im.imageUrl || {}).urlList || [];
      return { url: urls[0] || null, width: im.width || null, height: im.height || null };
    });
    out.slidesTitle = imgPost.title || null;
  }
  return out;
}

async function extract(rawUrl, opts = {}) {
  const res = await submitRetry(rawUrl, { locale: opts.locale || 'en' });
  const parsed = res.type === 'slides' ? parseSlides(res.text) : parseVideo(res.text);
  const result = {
    type: res.type,
    source: rawUrl,
    downloads: {
      video: parsed.video || null,
      hd: null,
      audio: parsed.audio || null,
      slides: parsed.slides || [],
      slidesAsVideo: null,
      cover: parsed.cover || null,
    },
    meta: {
      author: parsed.author || null,
      caption: parsed.caption || null,
      counts: parsed.counts || {},
      tt: parsed.tt,
      itemId: parsed.itemId || null,
      musicRawUrl: parsed.musicRaw || null,
    },
  };
  /* decode the tikcdn base64 payloads so the underlying CDN URLs are visible */
  const dd = result.downloads;
  dd.videoDirect = dd.video ? decodeTikcdn(dd.video) : null;
  dd.audioDirect = dd.audio ? decodeTikcdn(dd.audio) : null;
  dd.coverDirect = dd.cover ? decodeTikcdn(dd.cover) : null;
  if (dd.slides) for (const s of dd.slides) if (s.downloadUrl) s.directUrl = decodeTikcdn(s.downloadUrl);
  if (parsed.hdRequest && opts.hd !== false) {
    try {
      result.downloads.hd = await resolveHd(parsed.hdRequest, parsed.tt);
      result.downloads.hdDirect = decodeTikcdn(result.downloads.hd);
    } catch (e) {
      if (e.code !== 'LIMIT') result.errors = { ...(result.errors || {}), hd: e.message };
      else await sleep(4000); /* back off for the caller */
    }
  }
  if (res.type === 'slides') {
    const b64 = (res.text.match(/name="slides_data"\s+value="([^"]+)"/) || [])[1];
    if (b64) {
      try {
        result.downloads.slidesAsVideo = await slidesAsVideo(b64, parsed.slidesVideoEndpoint);
      } catch (e) {
        result.errors = { ...(result.errors || {}), slidesAsVideo: e.message };
      }
    }
  }
  if (opts.enrich !== false) {
    result.meta.detail = await enrich(rawUrl);
  }
  return result;
}

function sniffExt(buf) {
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.subarray(4, 8).toString() === 'ftyp') return 'mp4';
  if (buf.subarray(0, 3).toString() === 'ID3') return 'mp3';
  return null;
}

async function downloadTo(url, filePath, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await downloadOnce(url, filePath);
    } catch (e) {
      lastErr = e;
      /* only connection-level failures are worth retrying, not 4xx */
      if (e.code === 'HTTP' && !/download 5\d\d/.test(e.message)) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

async function downloadOnce(url, filePath) {
  const res = await fetch(url, { headers: { 'User-Agent': DESKTOP_UA } });
  if (!res.ok) throw new SstikError(`download ${res.status} for ${url.slice(0, 90)}`, 'HTTP');
  const buf = Buffer.from(await res.arrayBuffer());
  /* tikcdn slide links carry no extension and claim octet-stream, sniff instead */
  let finalPath = filePath;
  if (filePath.endsWith('.img')) {
    const ext = sniffExt(buf);
    if (ext) finalPath = filePath.slice(0, -3) + ext; /* keep the dot from '.img' */
  }
  const { writeFile } = await import('node:fs/promises');
  await writeFile(finalPath, buf);
  return { path: finalPath, bytes: buf.length, contentType: (res.headers.get('content-type') || '').split(';')[0].trim() };
}

function safeName(s) {
  return String(s || 'x').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 60);
}

async function saveDownloads(result, dir) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  const id = safeName(result.meta?.detail?.id || result.meta?.itemId || 'post');
  const saved = {};
  const job = result.downloads;
  if (job.video) saved.video = await downloadTo(job.video, `${dir}/video_${id}.mp4`);
  if (job.hd) saved.hd = await downloadTo(job.hd, `${dir}/video_${id}_hd.mp4`);
  if (job.audio) saved.audio = await downloadTo(job.audio, `${dir}/audio_${id}.mp3`);
  const slides = job.slides || [];
  for (let i = 0; i < slides.length; i++) {
    const href = slides[i].downloadUrl || slides[i].url;
    if (!href) continue;
    try {
      saved[`slide_${i + 1}`] = await downloadTo(href, `${dir}/slide_${id}_${i + 1}.img`);
    } catch (e) {
      saved[`slide_${i + 1}`] = { error: e.message };
    }
  }
  if (job.slidesAsVideo) {
    try {
      saved.slidesAsVideo = await downloadTo(job.slidesAsVideo, `${dir}/slides_${id}.mp4`);
    } catch (e) {
      saved.slidesAsVideo = { error: e.message };
    }
  }
  return saved;
}

async function main(argv) {
  const opts = { locale: 'en', hd: true, enrich: true };
  const urls = [];
  let downloadDir = null;
  let jsonOut = false;
  let delay = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') jsonOut = true;
    else if (a === '--no-enrich') opts.enrich = false;
    else if (a === '--no-hd') opts.hd = false;
    else if (a === '--locale') opts.locale = argv[++i];
    else if (a === '--download') {
      const n = argv[i + 1];
      if (n && !n.startsWith('--')) {
        downloadDir = n;
        i++;
      } else downloadDir = 'downloads';
    } else if (a === '--delay') delay = parseFloat(argv[++i]) || 0;
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else urls.push(a);
  }
  if (!urls.length) {
    console.error('usage: node sstik.js <tiktok-url> [<url2> ...] [--json] [--download [dir]] [--locale en] [--delay SECONDS] [--no-enrich] [--no-hd]');
    process.exit(2);
  }
  const results = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const r = await extract(urls[i], opts);
      if (downloadDir) r.saved = await saveDownloads(r, downloadDir);
      results.push(r);
    } catch (e) {
      results.push({ source: urls[i], error: e.message, code: e.code });
    }
    if (i < urls.length - 1 && delay) await sleep(delay * 1000);
  }
  console.log(JSON.stringify(results, null, jsonOut ? 0 : 2));
  process.exit(results.every((r) => !r.error) ? 0 : 1);
}

module.exports = { extract, enrich, submit, getToken, resolveHd, slidesAsVideo, decodeTikcdn, downloadTo };

if (require.main === module) main(process.argv.slice(2)).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
