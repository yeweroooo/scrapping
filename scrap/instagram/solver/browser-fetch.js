#!/usr/bin/env node
'use strict';
/*
 * browser-fetch.js - run one already-signed fastdl.app API call from inside a real browser page.
 *
 * This is the reference repo's "mirror mode" in miniature (sarperavci/CloudflareBypassForScraping):
 * when Cloudflare challenges the HTTP client, the same request is replayed by the page itself, so it
 * carries the browser's TLS fingerprint, cookies and any challenge state the page has collected.
 * If the site decides a Turnstile solve is needed it does so in-page first; a solved challenge leaves
 * the wh-cf-token in the page's sessionStorage, which is reported back alongside the response.
 *
 * stdout: one JSON line {ok, status, body, wh_cf_token} or {ok:false, error}.
 *
 * Usage: node browser-fetch.js --path /api/convert --body '{"target_url":"..."}' [--page URL] [--timeout MS]
 */

const path = require('path');
const fs = require('fs');

const DEFAULT_PAGE = 'https://fastdl.app/';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const has = (name) => process.argv.includes('--' + name);

const apiPath = arg('path');
const body = arg('body', '{}');
const pageUrl = arg('page', DEFAULT_PAGE);
const timeoutMs = Number(arg('timeout', 60000));
const log = (msg) => process.stderr.write(`[browser] ${msg}\n`);

function pickExecutable(chromium) {
  try {
    const bundled = chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch { /* not installed */ }
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

(async () => {
  if (!apiPath) throw new Error('--path is required');
  const { chromium } = require(path.join(__dirname, 'node_modules', 'patchright'));
  const browser = await chromium.launch({
    headless: has('headless'),
    executablePath: pickExecutable(chromium),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  try {
    const context = await browser.newContext({ userAgent: DEFAULT_UA, viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    log(`opening ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    log(`calling ${apiPath} from the page`);
    const result = await page.evaluate(async ({ apiPath: p, body: b, timeoutMs: t }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), t);
      try {
        const res = await fetch('https://api-wh.fastdl.app' + p, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: b,
          signal: controller.signal,
        });
        return { ok: true, status: res.status, body: await res.text() };
      } catch (err) {
        return { ok: false, error: err.message };
      } finally {
        clearTimeout(timer);
      }
    }, { apiPath, body, timeoutMs });

    const whCfToken = await page.evaluate(() => { try { return sessionStorage.getItem('wh_cf_token'); } catch { return null; } });
    const out = { ...result, wh_cf_token: whCfToken };
    process.stdout.write(JSON.stringify(out) + '\n');
    if (!result.ok || result.status >= 400) process.exit(1);
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
  process.exit(1);
});
