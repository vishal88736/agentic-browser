// tests/e2eExtension.test.js
//
// Loads the MV3 extension into headless Chromium and verifies it actually
// boots in an extension runtime: manifest parses, the background service
// worker starts and exposes the expected manifest, and the content scripts
// inject into a live page and produce a value-free DOM snapshot.
//
// This verifies "real extension execution" (one of the previously-unverified
// items). It does NOT exercise live VLM inference or pixel OCR, which still
// need a WebGPU/WASM model.

import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const EXT_DIR = process.cwd();

function serve(html) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

test('extension loads: manifest + service worker + content-script injection', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-ext-'));
  const { server, url } = await serve(`<!DOCTYPE html><html><body>
    <form><label for="e">Email</label><input id="e" value="leak@example.com">
    <input id="p" type="password" value="Secret123"></form>
    <img src="pan-card.png" alt="PAN Card" width="400" height="252">
  </body></html>`);

  const browser = await puppeteer.launch({
    headless: true,
    userDataDir,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  try {
    // 1. The service worker should register once the browser has started.
    let workerTarget;
    try {
      workerTarget = await browser.waitForTarget(
        (tg) => tg.type() === 'service_worker',
        { timeout: 15000 }
      );
    } catch {
      assert.fail('background service worker target did not register — extension did not boot');
    }

    const sw = await workerTarget.worker();
    const manifest = await sw.evaluate(() => {
      try {
        const m = chrome.runtime.getManifest();
        return { manifest_version: m.manifest_version, name: m.name };
      } catch (e) {
        return { error: String(e) };
      }
    });
    assert.equal(manifest.manifest_version, 3, `service worker sees manifest_version 3, got ${JSON.stringify(manifest)}`);

    // 2. Content scripts inject into a live http page (isolated world) and the
    //    REAL messaging path returns a value-free DOM snapshot.
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 500));

    const resp = await sw.evaluate(() => new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => {
        const t = tabs.find((x) => x.url && x.url.startsWith('http://127.0.0.1'));
        if (!t) return resolve({ __error: 'tab not found', tabs: tabs.map(x => x.url) });
        chrome.tabs.sendMessage(t.id, { type: 'SNAPSHOT_DOM' }, (r) => {
          if (chrome.runtime.lastError) return resolve({ __error: chrome.runtime.lastError.message });
          resolve(r);
        });
      });
    }));

    assert.ok(!resp.__error, `content script did not respond: ${resp.__error}${resp.tabs ? ' (tabs: ' + JSON.stringify(resp.tabs) + ')' : ''}`);
    assert.ok(Array.isArray(resp.fields), 'SNAPSHOT_DOM returned fields');
    assert.ok(Array.isArray(resp.mediaCandidates), 'SNAPSHOT_DOM returned mediaCandidates');

    const wire = JSON.stringify(resp);
    assert.ok(!wire.includes('leak@example.com'), 'content script must not read email value');
    assert.ok(!wire.includes('Secret123'), 'content script must not read password value');
    assert.ok(resp.fields.some(f => f.inputType === 'password'), 'password field captured structurally');
    assert.ok(resp.mediaCandidates.some(m => m.alt === 'PAN Card'), 'PAN image captured as a media candidate');
  } finally {
    await browser.close();
    server.close();
  }
});