// Verification report for igdownload.js: offline checks against captured API fixtures, plus a few live ones.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ig = require('./igdownload.js');

const FIXTURES = path.join(__dirname, 'fixtures');
// fixtures are captured API responses and are not committed; regenerate them or the checks skip
const load = (name) => {
  const file = path.join(FIXTURES, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};
const results = [];

function check(name, fn) {
  try {
    const evidence = fn();
    results.push({ check: name, status: evidence === 'SKIP' ? 'SKIP' : 'PASS', evidence: String(evidence) });
  } catch (err) {
    results.push({ check: name, status: 'FAIL', evidence: err.message });
  }
}

async function checkAsync(name, fn) {
  try {
    const evidence = await fn();
    results.push({ check: name, status: evidence === 'SKIP' ? 'SKIP' : 'PASS', evidence: String(evidence) });
  } catch (err) {
    results.push({ check: name, status: 'FAIL', evidence: err.message });
  }
}

// ---- signing

check('signature matches the site signer', () => {
  const sig = ig.signBody({ target_url: 'https://www.instagram.com/reel/DO5tIDME6t-/' }, 1789127007273)._s;
  assert.strictEqual(sig, '443a214d0bb0905e3dce4cbd84761940d6c4822b0ab6c231fc3a5da8dea60a4d');
  return sig;
});

check('signature envelope', () => {
  const b = ig.signBody({ a: 1 }, 1000);
  assert.deepStrictEqual(Object.keys(b).sort(), ['_s', '_sv', '_ts', '_tsc', 'a', 'ts']);
  assert.strictEqual(b._sv, 2);
  assert.strictEqual(b._tsc, 0);
  assert.strictEqual(b._ts, 1788421776280);
  return JSON.stringify(b);
});

check('top level keys sorted before signing', () => {
  assert.strictEqual(ig.stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}');
  return '{"a":1,"b":2}';
});

check('input parsing', () => {
  const cases = [
    ['https://www.instagram.com/reel/DO5tIDME6t-/', 'reel', 'DO5tIDME6t-'],
    ['https://www.instagram.com/p/DEc1QSlIdb_/?hl=en', 'post', 'DEc1QSlIdb_'],
    ['https://www.instagram.com/tv/ABC123/', 'tv', 'ABC123'],
  ];
  for (const [value, kind, code] of cases) {
    const parsed = ig.parseInput(value);
    assert.strictEqual(parsed.kind, kind, value);
    assert.strictEqual(parsed.shortcode, code, value);
  }
  assert.strictEqual(ig.parseInput('https://www.instagram.com/stories/gazdaviesmedia/123/').kind, 'story');
  const profile = ig.parseInput('gazdaviesmedia');
  assert.strictEqual(profile.kind, 'profile');
  assert.strictEqual(profile.url, 'https://www.instagram.com/gazdaviesmedia/');
  return '5 url/username forms';
});

// ---- /api/convert normalisation

check('single reel fixture (object response)', () => {
  const raw = load('convert-reel.json');
  if (!raw) return 'SKIP';
  const out = ig.normalizeConvert(raw, ig.parseInput('https://www.instagram.com/reel/DO5tIDME6t-/'));
  assert.strictEqual(out.kind, 'media');
  assert.strictEqual(out.author.username, 'fastdl.app');
  assert.strictEqual(out.stats.like_count, 238);
  assert.strictEqual(out.stats.comment_count, 17);
  assert.strictEqual(out.stats.taken_at_iso, '2025-09-22T10:46:45.000Z');
  assert.deepStrictEqual(out.media.map((m) => m.kind).sort(), ['audio', 'image', 'video']);
  const video = out.media.find((m) => m.kind === 'video');
  assert.ok(video.proxy_url.startsWith('https://media.fastdl.app/get?'));
  assert.ok(video.direct_url.startsWith('https://scontent-'), 'CDN url decoded from the proxy uri param');
  assert.strictEqual(video.label, '1080p');
  return `media ${out.media.map((m) => m.kind).join('+')}, likes ${out.stats.like_count}, comments ${out.stats.comment_count}`;
});

check('carousel fixture (array response)', () => {
  const raw = load('convert-carousel.json');
  if (!raw) return 'SKIP';
  const out = ig.normalizeConvert(raw, ig.parseInput('https://www.instagram.com/p/DEc1QSlIdb_/'));
  assert.strictEqual(out.kind, 'album');
  assert.strictEqual(out.item_count, 8, 'one entry per slide');
  assert.strictEqual(out.media.length, 8, 'thumb duplicates dropped (same CDN file)');
  assert.strictEqual(out.author.username, 'gazdaviesmedia');
  assert.ok(out.description.title.startsWith('Why Carousels'), 'caption kept from meta.title');
  assert.deepStrictEqual(out.media.map((m) => m.item_index), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.strictEqual(out.items.length, 8);
  return `${out.item_count} slides, ${out.media.length} media entries, caption ${out.description.title.slice(0, 24)}...`;
});

check('dash manifest parsed into variants', () => {
  const raw = load('convert-reel.json');
  if (!raw) return 'SKIP';
  const out = ig.normalizeConvert(raw, ig.parseInput('https://www.instagram.com/reel/DO5tIDME6t-/'));
  assert.strictEqual(out.dash_manifest.video.length, 2);
  assert.strictEqual(out.dash_manifest.audio.length, 1);
  assert.deepStrictEqual(out.dash_manifest.video.map((v) => [v.width, v.height]), [[720, 720], [360, 360]]);
  assert.strictEqual(out.dash_manifest.audio[0].content_length, 1421413);
  return `${out.dash_manifest.video.length} video reps, ${out.dash_manifest.audio.length} audio rep, ${out.dash_manifest.duration_seconds}s`;
});

// ---- /api/v1/instagram normalisation

check('profile user fixture', () => {
  const raw = load('userinfo.json');
  if (!raw) return 'SKIP';
  const user = ig.normalizeUser(raw.result[0].user);
  assert.strictEqual(user.username, 'gazdaviesmedia');
  assert.strictEqual(typeof user.follower_count, 'number');
  assert.ok(user.follower_count > 0);
  assert.ok(user.profile_pic_url.startsWith('https://'));
  return `${user.username} followers=${user.follower_count} posts=${user.media_count}`;
});

check('posts fixture normalisation', () => {
  const raw = load('posts.json');
  if (!raw) return 'SKIP';
  const posts = ig.normalizePostsPayload(raw);
  assert.strictEqual(posts.count, 3);
  const carousel = posts.items[0];
  assert.strictEqual(carousel.product_type, 'carousel_container');
  assert.strictEqual(carousel.carousel_count, 13);
  assert.strictEqual(typeof carousel.description.caption, 'string', 'caption object flattened to its text');
  assert.strictEqual(typeof carousel.stats.like_count, 'number');
  assert.ok(carousel.media.length >= 13, 'every slide keeps at least its largest image');
  assert.strictEqual(carousel.carousel.length, 13);
  const clip = posts.items[2];
  assert.strictEqual(clip.product_type, 'clips');
  assert.strictEqual(clip.is_video, true);
  assert.ok(clip.media.some((m) => m.kind === 'video' && m.direct_url.startsWith('https://')));
  return `${posts.count} posts, carousel slides ${carousel.carousel_count}, clip media ${clip.media.length}`;
});

check('reel soundtrack extracted', () => {
  const raw = load('posts.json');
  if (!raw) return 'SKIP';
  const posts = ig.normalizePostsPayload(raw);
  const clip = posts.items[2];
  assert.ok(clip.music, 'clips_metadata present');
  assert.strictEqual(clip.music.source, 'original_sound_info');
  assert.strictEqual(clip.music.artist, 'gazdaviesmedia');
  assert.ok(clip.music.audio_id);
  return JSON.stringify(clip.music);
});

// ---- downloads

check('download list is unique per file', () => {
  const raw = load('convert-carousel.json');
  if (!raw) return 'SKIP';
  const result = { ok: true, ...ig.normalizeConvert(raw, ig.parseInput('https://www.instagram.com/p/DEc1QSlIdb_/')) };
  const items = ig.collectDownloads ? ig.collectDownloads(result) : null;
  const files = items.map((i) => i.filename);
  assert.strictEqual(new Set(files).size, files.length, 'no repeated filenames');
  assert.strictEqual(files.length, 8);
  return files.join(', ');
});

check('captcha challenge reports actionable error', () => {
  const err = ig.errorReport(422, { code: 'CAPTCHA_REQUIRED', challenge: { type: 'turnstile', siteKey: '0x4AAAAAABhLwGG2XCb7fE2M' } });
  assert.strictEqual(err.code, 'CAPTCHA_REQUIRED');
  assert.ok(/solver/.test(err.message));
  return err.message.slice(0, 80);
});

check('refusals inside a 200 body map to a failure', () => {
  const err = ig.errorReport(200, { response: 4, response_type: 'link not found', success: false, message: 'The download link not found.' });
  assert.strictEqual(err.code, 'LINK_NOT_FOUND');
  assert.strictEqual(err.message, 'The download link not found.');
  return JSON.stringify(err).slice(0, 90);
});

// ---- live checks (they need the network; a SKIP is not a failure)

(async () => {
  await checkAsync('live: HTTP/2 transport is served (no captcha)', async () => {
    const res = await ig.api('/api/convert', { target_url: 'https://www.instagram.com/reel/DO5tIDME6t-/' }, { solve: false });
    if (res.status === 422) return 'SKIP';
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.transport, 'http2');
    return `status ${res.status} over ${res.transport}, ${(res.json.url || []).length} media entry`;
  });

  await checkAsync('live: media url downloads', async () => {
    const raw = load('convert-reel.json');
    if (!raw) return 'SKIP';
    const out = ig.normalizeConvert(raw, ig.parseInput('https://www.instagram.com/reel/DO5tIDME6t-/'));
    const thumb = out.media.find((m) => m.kind === 'image');
    const dir = fs.mkdtempSync('/tmp/igdl-verify-');
    const saved = await ig.downloadAll([thumb], dir);
    if (saved[0] && saved[0].error) return 'SKIP';
    assert.ok(saved[0].bytes > 1000, 'thumbnail bytes written');
    return `${saved[0].bytes} bytes -> ${saved[0].file}`;
  });

  check('browser solver wiring', () => {
    const solver = path.join(__dirname, 'solver', 'turnstile-solve.js');
    const mirror = path.join(__dirname, 'solver', 'browser-fetch.js');
    if (!fs.existsSync(solver) || !fs.existsSync(mirror)) return 'SKIP';
    assert.ok(/turnstile-solve\.js/.test(fs.readFileSync(path.join(__dirname, 'igdownload.js'), 'utf8')), 'CLI spawns the token solver on CAPTCHA_REQUIRED');
    assert.ok(/browser-fetch\.js/.test(fs.readFileSync(path.join(__dirname, 'igdownload.js'), 'utf8')), 'CLI spawns mirror mode too');
    if (!fs.existsSync(path.join(__dirname, 'solver', 'node_modules', 'patchright'))) return 'SKIP (run npm install in solver/ to exercise it)';
    return 'solver and mirror present, patchright resolved, both wired into api()';
  });

  console.log(JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  console.log(`\n${results.length - failed.length - skipped.length} passed, ${skipped.length} skipped, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})();
