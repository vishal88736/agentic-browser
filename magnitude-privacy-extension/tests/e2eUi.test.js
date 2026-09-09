// tests/e2eUi.test.js
//
// Loads the extension and opens its own pages (popup, options, demo) to verify
// the redesigned UI actually renders with the real runtime state module — no
// hardcoded status, and the demo runs the real local detectors.

import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const EXT_DIR = process.cwd();

async function launch() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-ui-'));
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-sandbox', '--disable-dev-shm-usage']
  });
  const workerTarget = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 15000 });
  const sw = await workerTarget.worker();
  const id = await sw.evaluate(() => chrome.runtime.id);
  return { browser, id };
}

function pageErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

test('popup renders real status: title, stepper, stat grid', async () => {
  const { browser, id } = await launch();
  try {
    const page = await browser.newPage();
    const errors = pageErrors(page);
    await page.goto(`chrome-extension://${id}/popup/popup.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#stepper .step');

    const title = await page.$eval('#statusTitle', (el) => el.textContent);
    const steps = await page.$$eval('#stepper .step', (els) => els.length);
    const stats = await page.$$eval('#statGrid .stat', (els) => els.length);

    assert.ok(title && title.length > 0, 'status title must be populated');
    assert.equal(steps, 5, 'pipeline must have 5 steps');
    assert.equal(stats, 5, 'stat grid must have 5 stats');
    assert.deepEqual(errors, [], 'no page errors: ' + errors.join('; '));
  } finally { await browser.close(); }
});

test('options renders diagnostics and model status', async () => {
  const { browser, id } = await launch();
  try {
    const page = await browser.newPage();
    const errors = pageErrors(page);
    await page.goto(`chrome-extension://${id}/options/options.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#diag .kv');

    const diagCount = await page.$$eval('#diag .kv', (els) => els.length);
    const vlm = await page.$eval('#vlmStatus', (el) => el.textContent);

    assert.ok(diagCount >= 5, 'diagnostics must render kv rows');
    assert.ok(vlm && vlm.length > 0, 'VLM status must render');
    assert.deepEqual(errors, [], 'no page errors: ' + errors.join('; '));
  } finally { await browser.close(); }
});

test('demo mode runs real detectors and redacts the synthetic document', async () => {
  const { browser, id } = await launch();
  try {
    const page = await browser.newPage();
    const errors = pageErrors(page);
    await page.goto(`chrome-extension://${id}/demo/demo.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#docAfter .redacted-tag');

    const tag = await page.$eval('#docAfter .redacted-tag', (el) => el.textContent);
    const redactedFields = await page.$$eval('#fieldsAfter .redacted', (els) => els.length);

    assert.ok(/REDACTED/.test(tag), 'document must be redacted with neutral label, got: ' + tag);
    assert.ok(redactedFields >= 1, 'sensitive fields must be redacted in after view');
    assert.deepEqual(errors, [], 'no page errors: ' + errors.join('; '));
  } finally { await browser.close(); }
});