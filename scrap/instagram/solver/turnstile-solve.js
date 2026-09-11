#!/usr/bin/env node
'use strict';
/*
 * turnstile-solve.js - mint a Cloudflare Turnstile token for fastdl.app with a stealth browser.
 *
 * The hub can answer HTTP 422 CAPTCHA_REQUIRED with a Turnstile challenge (siteKey in the body).
 * A token only validates for the hostnames registered on that siteKey, so the widget is rendered
 * from a real page on https://fastdl.app/ instead of a local file.
 *
 * Method follows sarperavci/CloudflareBypassForScraping: a patched Chromium (patchright, its own
 * build when installed, otherwise the system chromium) runs headful against the box's X display,
 * the widget is rendered both implicitly (div.cf-turnstile) and explicitly (turnstile.render), and
 * an interactive checkbox inside the widget is clicked natively when Cloudflare asks for one.
 * The token is then exchanged at POST /api/cf for the wh-cf-token header value the API expects.
 *
 * stdout is a single JSON line: {ok, token, wh_cf_token, cookies, elapsed_ms} or {ok:false, error, console}.
 *
 * Usage: node turnstile-solve.js [--sitekey K] [--page URL] [--exchange] [--headless]
 *                                [--timeout MS] [--probe] [--debug]
 */

const path = require('path');
const fs = require('fs');

const DEFAULT_SITEKEY = '0x4AAAAAABhLwGG2XCb7fE2M';
const DEFAULT_PAGE = 'https://fastdl.app/';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const HUB = 'https://api-wh.fastdl.app';

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const has = (name) => process.argv.includes('--' + name);

const siteKey = arg('sitekey', DEFAULT_SITEKEY);
const pageUrl = arg('page', DEFAULT_PAGE);
const timeoutMs = Number(arg('timeout', 90000));
const exchange = has('exchange');

const log = (msg) => process.stderr.write(`[solver] ${msg}\n`);

// patchright ships its own Chromium; fall back to the distro build when it was not installed.
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

async function waitForToken(page, deadline, console_log) {
  let polls = 0;
  for (;;) {
    polls++;
    const state = await page.evaluate(() => {
      const input = document.querySelector('[name="cf-turnstile-response"]');
      return {
        explicit: window.__turnstileToken || null,
        error: window.__turnstileError || null,
        implicit: input && input.value ? input.value : null,
      };
    }).catch(() => ({}));
    const token = state.explicit || state.implicit;
    if (token) return token;
    if (state.error) throw new Error('widget reported ' + state.error);
    if (Date.now() > deadline) {
      throw Object.assign(new Error('timeout waiting for a Turnstile token'), { console: console_log.slice(-6) });
    }
    // The checkbox lives inside a closed shadow root, so click the widget box itself.
    const box = await page.locator('#igdownload-turnstile, #igdl-embed-widget').first().boundingBox({ timeout: 1200 }).catch(() => null);
    if (box) await page.mouse.click(box.x + 30, box.y + box.height / 2).catch(() => {});
    if (has('debug') && polls % 5 === 0) {
      log('debug ' + JSON.stringify(await page.evaluate(() => ({
        api: typeof window.turnstile,
        widget: (document.getElementById('igdl-embed-widget') || {}).innerHTML?.length || 0,
      })).catch((e) => ({ err: e.message }))));
      await page.screenshot({ path: '/tmp/turnstile-debug.png' }).catch(() => {});
    }
    await page.waitForTimeout(1000);
  }
}

(async () => {
  const started = Date.now();
  const { chromium } = require(path.join(__dirname, 'node_modules', 'patchright'));
  const executablePath = pickExecutable(chromium);
  log(`launching ${executablePath || 'patchright chromium'}`);

  const browser = await chromium.launch({
    headless: has('headless'),
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      // this box has no GPU: force software GL so the challenge's profiling step can run
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
    ],
  });
  const consoleLog = [];
  try {
    const context = await browser.newContext({
      userAgent: DEFAULT_UA,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      timezoneId: 'Asia/Jakarta',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('console', (m) => consoleLog.push(`${m.type()}: ${m.text().slice(0, 160)}`));

    log(`opening ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    log(`rendering the widget for ${siteKey}`);
    await page.evaluate((key) => {
      window.__turnstileToken = null;
      window.__turnstileError = null;
      // implicit render: Cloudflare fills the hidden input when the challenge passes
      const embed = document.createElement('div');
      embed.className = 'cf-turnstile';
      embed.id = 'igdl-embed-widget';
      embed.setAttribute('data-sitekey', key);
      embed.style.cssText = 'position:fixed;left:20px;bottom:20px;z-index:2147483646;background:#fff';
      document.body.appendChild(embed);
      // explicit render: gives us a callback token without scraping the input
      const explicit = document.createElement('div');
      explicit.id = 'igdownload-turnstile';
      explicit.style.cssText = 'position:fixed;left:340px;bottom:20px;z-index:2147483647;background:#fff';
      document.body.appendChild(explicit);

      // window.turnstile can take a while to appear (and may never, in which case the implicit
      // widget above still carries the challenge), so poll instead of rendering once
      const renderExplicit = () => {
        if (!window.turnstile || window.__turnstileRendered) return;
        window.__turnstileRendered = true;
        try {
          window.turnstile.render(explicit, {
            sitekey: key,
            callback: (token) => { window.__turnstileToken = token; },
            'error-callback': () => { window.__turnstileError = 'error-callback'; },
            'timeout-callback': () => { window.__turnstileError = 'timeout-callback'; },
          });
        } catch (err) {
          window.__turnstileRenderNote = 'render threw: ' + err.message;
        }
      };
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      script.async = true;
      script.defer = true;
      script.addEventListener('error', () => { window.__turnstileError = 'api.js failed to load'; });
      document.head.appendChild(script);
      const poll = setInterval(() => {
        if (window.__turnstileRendered || (window.__turnstileError && !window.turnstile)) { clearInterval(poll); return; }
        renderExplicit();
      }, 500);
      setTimeout(() => clearInterval(poll), 60000);
    }, siteKey);

    const token = await waitForToken(page, Date.now() + timeoutMs, consoleLog);
    log(`token acquired (${token.length} chars)`);
    const cookies = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
    const out = { ok: true, token, wh_cf_token: null, cookies, elapsed_ms: Date.now() - started };
    if (has('probe')) out.console = consoleLog.slice(-10);

    if (exchange) {
      const res = await fetch(`${HUB}/api/cf`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://fastdl.app',
          Referer: 'https://fastdl.app/',
          'User-Agent': DEFAULT_UA,
        },
        body: new URLSearchParams({ cfToken: token }),
      });
      const json = await res.json().catch(() => ({}));
      if (typeof json.result !== 'string' || !json.result) throw new Error('wh-cf-token exchange failed: ' + JSON.stringify(json));
      out.wh_cf_token = json.result;
      log('exchanged for wh-cf-token');
    }
    process.stdout.write(JSON.stringify(out) + '\n');
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((err) => {
  const payload = { ok: false, error: err.message };
  if (err.console) payload.console = err.console;
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(1);
});
