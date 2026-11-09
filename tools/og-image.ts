// Renders tools/og/card.html to public/og.png (1200×630) with the Playwright Chromium already in devDependencies.
// Run: npm run og:regen. Commit the PNG: social crawlers need a raster image at a fixed URL.
import { chromium } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(root, 'tools/og/card.html')).href);
await page.screenshot({ path: join(root, 'public/og.png'), type: 'png' });
await browser.close();
console.log('wrote public/og.png');
