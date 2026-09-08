import { test } from 'node:test';
import assert from 'node:assert';
import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';

test('sanitizeScreenshot redaction region visual assertion', async (t) => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  // Create a minimal HTML page to inject our module
  await page.setContent(`
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { margin: 0; padding: 0; background: white; }
          #sensitive { 
            position: absolute; 
            left: 50px; 
            top: 50px; 
            width: 100px; 
            height: 20px; 
            background: red; 
          }
        </style>
      </head>
      <body>
        <div id="sensitive">Sensitive Text</div>
      </body>
    </html>
  `);

  // Take a screenshot
  const screenshotBase64 = await page.screenshot({ encoding: 'base64' });
  const dataUrl = `data:image/png;base64,${screenshotBase64}`;

  // Read the sanitize.js file to inject it
  const sanitizeCode = fs.readFileSync(path.join(process.cwd(), 'shared', 'sanitize.js'), 'utf8');

  // Strip export statements to evaluate in the page context directly
  const runnableCode = sanitizeCode.replace(/export /g, '');

  const resultDataUrl = await page.evaluate(async (code, inputDataUrl) => {
    // Inject the code
    const script = document.createElement('script');
    script.textContent = code;
    document.body.appendChild(script);

    // Bbox of the sensitive element
    const sensitiveRegions = [{
      bbox: { x: 50, y: 50, width: 100, height: 20 }
    }];

    // Call sanitizeScreenshot
    return await window.sanitizeScreenshot(inputDataUrl, sensitiveRegions);
  }, runnableCode, dataUrl);

  // Load the resulting dataUrl into a canvas to check pixels
  const isRedacted = await page.evaluate(async (sanitizedDataUrl) => {
    const img = new Image();
    img.src = sanitizedDataUrl;
    await new Promise(r => img.onload = r);

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    // Sample a pixel right in the middle of the redacted region (x: 100, y: 60)
    const pixel = ctx.getImageData(100, 60, 1, 1).data;
    
    // Pixel should be black [0, 0, 0, 255]
    return pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 255;
  }, resultDataUrl);

  assert.strictEqual(isRedacted, true, 'Sensitive region should be entirely blacked out');

  await browser.close();
});
