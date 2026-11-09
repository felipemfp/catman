import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import golden from '../src/core/fixtures/replay.json' with { type: 'json' };
import { dies, diesPayload, fmt, hooks } from './helpers.ts';

test('E2E 1 boot: canvas, no console errors, URL gains a valid seed', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await hooks(page);
  await expect(page.locator('canvas')).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get('s')).toMatch(/^[0-9a-z]{4,12}$/);
  expect(errors).toEqual([]);
});

test('E2E 2 seed: kept when valid, replaced when not', async ({ page }) => {
  await page.goto('/?s=abcd');
  await hooks(page);
  expect(await page.evaluate(() => window.__catman.seed)).toBe('abcd');
  await page.goto('/?s=BAD!');
  await hooks(page);
  const s = await page.evaluate(() => window.__catman.seed);
  expect(s).toMatch(/^[0-9a-z]{4,12}$/);
  expect(new URL(page.url()).searchParams.get('s')).toBe(s);
});

test('E2E 3 input: holding → moves the cat; releasing stops it within 10 ticks', async ({ page }) => {
  await page.goto('/?s=input1');
  await hooks(page);
  await page.click('#btn-play');
  await page.waitForFunction(() => window.__catman.tick() > 5);
  const x0 = await page.evaluate(() => window.__catman.catX());
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(500);
  await page.keyboard.up('ArrowRight');
  const t0 = await page.evaluate(() => window.__catman.tick());
  expect(await page.evaluate(() => window.__catman.catX())).toBeGreaterThan(x0);
  await page.waitForFunction((t) => window.__catman.tick() >= t + 10, t0);
  const x1 = await page.evaluate(() => window.__catman.catX());
  await page.waitForFunction((t) => window.__catman.tick() >= t + 20, t0);
  expect(await page.evaluate(() => window.__catman.catX())).toBe(x1);
});

test('E2E 4 share round trip', async ({ page, browser }) => {
  await page.goto(`/?s=${dies.seed}`);
  await hooks(page);
  const r = await page.evaluate((l) => window.__catman.playLog(l), dies.levels);
  expect(r.ended?.cause).toBe('rats');
  await page.waitForFunction(() => window.__catman.ui().screen === 'death');
  expect(await page.evaluate(() => window.__catman.ui().deathScore)).toBe(dies.ended!.score);
  await page.click('#btn-share');
  await page.waitForFunction(() => (window.__catman.ui().shareLink ?? '').includes('g='));
  const link = (await page.evaluate(() => window.__catman.ui().shareLink))!;
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await p2.goto(new URL(link).pathname + new URL(link).search);
  await hooks(p2);
  await expect.poll(() => p2.evaluate(() => window.__catman.ghostStatus()), { timeout: 10_000 }).toBe(`ready: ${fmt(dies.ended!.score)} to beat`);
  await ctx.close();
});

test('E2E 5 ghost retry: four 404s then the ghost → ready; all 404 → unavailable', async ({ page }) => {
  let n = 0;
  await page.route('**/api/ghost/*', (route) => {
    n++;
    if (n <= 4) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(diesPayload()) });
  });
  await page.clock.install();
  await page.goto(`/?s=${dies.seed}&g=AAAAAAAA`);
  await page.clock.runFor(1000);
  await hooks(page);
  for (let i = 0; i < 25 && n < 5; i++) await page.clock.runFor(1000);
  expect(n).toBe(5);
  for (let i = 0; i < 40; i++) {
    if ((await page.evaluate(() => window.__catman.ghostStatus())).startsWith('ready')) break;
    await page.clock.runFor(100);
  }
  expect(await page.evaluate(() => window.__catman.ghostStatus())).toBe(`ready: ${fmt(dies.ended!.score)} to beat`);

  const p2 = await page.context().newPage();
  let m = 0;
  await p2.route('**/api/ghost/*', (route) => { m++; return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }); });
  await p2.clock.install();
  await p2.goto(`/?s=${dies.seed}&g=BBBBBBBB`);
  await p2.clock.runFor(1000);
  await hooks(p2);
  for (let i = 0; i < 80 && m < 7; i++) await p2.clock.runFor(1000);
  await p2.clock.runFor(500);
  expect(m).toBe(7);
  expect(await p2.evaluate(() => window.__catman.ghostStatus())).toBe('unavailable');
});

for (const [name, over, status] of [
  ['coreVersion 0', { coreVersion: 0 }, 'older version'],
  ['score + 1', { score: dies.ended!.score + 1 }, "doesn't match"],
] as const) {
  test(`E2E 6 bad ghost (${name}) → ${status}; Play still works`, async ({ page }) => {
    await page.route('**/api/ghost/*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(diesPayload(over)) }));
    await page.goto(`/?s=${dies.seed}&g=CCCCCCCC`);
    await hooks(page);
    await expect.poll(() => page.evaluate(() => window.__catman.ghostStatus()), { timeout: 10_000 }).toBe(status);
    await page.click('#btn-play');
    await page.waitForFunction(() => window.__catman.ui().screen === 'run' && window.__catman.tick() > 3);
  });
}

test('E2E 7 determinism: headless replay and the live loop both match the golden hash', async ({ page }) => {
  await page.goto('/?s=golden1');
  await hooks(page);
  expect(await page.evaluate(([s, l]) => window.__catman.coreReplay(s, l), [golden.seed, golden.levels] as const)).toBe(golden.hash);
  const r = await page.evaluate((l) => window.__catman.playLog(l), golden.levels);
  expect(r.hash).toBe(golden.hash);
});

test('E2E 8 prod bundle has no test hooks', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'file check, once is enough');
  const dir = 'dist';
  expect(existsSync(dir), 'dist/ missing: run `npm run build` first (npm run check does)').toBe(true);
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  const files = walk(dir);
  // code is html/js/css; the only static files are the social image and the favicon (E2E 12)
  const statics = ['og.png', 'favicon.svg'].map((f) => join(dir, f));
  expect(files.filter((f) => !statics.includes(f)).every((f) => /\.(html|js|css)$/.test(f))).toBe(true);
  for (const f of files.filter((x) => !x.endsWith('.png'))) {
    const s = readFileSync(f, 'utf8');
    for (const bad of ['__catman', 'playLog', 'coreReplay']) expect(s.includes(bad), `${f} contains ${bad}`).toBe(false);
  }
});

test('E2E 9 share failure → visible error and a seed-only fallback', async ({ page }) => {
  await page.route('**/api/ghost', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"rate_limited"}' }));
  await page.goto(`/?s=${dies.seed}`);
  await hooks(page);
  await page.evaluate((l) => window.__catman.playLog(l), dies.levels);
  await page.waitForFunction(() => window.__catman.ui().screen === 'death');
  await page.click('#btn-share');
  await page.waitForFunction(() => window.__catman.ui().errorText !== null);
  const ui = await page.evaluate(() => window.__catman.ui());
  expect(ui.errorText).not.toBe('');
  expect(ui.shareLink).toMatch(new RegExp(`/\\?s=${dies.seed}$`));
  await expect(page.locator('#btn-copy-seed')).toBeVisible();
});

test('E2E 10 pools stay flat', async ({ page }) => {
  await page.goto('/?s=golden1');
  await hooks(page);
  const samples = await page.evaluate(async (levels) => {
    const out: string[] = [];
    const done = window.__catman.playLog(levels);
    let finished = false;
    void done.then(() => { finished = true; });
    while (!finished) {
      await new Promise((r) => requestAnimationFrame(r));
      if (window.__catman.tick() >= 120) {
        const s = window.__catman.poolStats();
        out.push(Object.keys(s).sort().map((k) => `${k}:${s[k]!.allocated}`).join(','));
      }
    }
    return out;
  }, golden.levels.slice(0, 720));
  expect(samples.length).toBeGreaterThan(10);
  expect(new Set(samples).size).toBe(1);
});

test('E2E 11 view toggle: 2.5D by default; V and the button switch views, the choice persists, ?view= overrides; no errors', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?s=view1');
  await hooks(page);
  expect(await page.evaluate(() => window.__catman.view())).toBe('tilt');
  await expect(page.getByRole('button', { name: 'Switch to top-down view' })).toBeVisible();
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForFunction(() => window.__catman.tick() > 700); // a gate pair on screen
  await page.screenshot({ path: info.outputPath('tilt.png') });
  await page.keyboard.press('v');
  expect(await page.evaluate(() => window.__catman.view())).toBe('flat');
  await page.screenshot({ path: info.outputPath('flat.png') });
  await expect(page.getByRole('button', { name: 'Switch to 2.5D view' })).toBeVisible();
  await page.goto('/?s=view1');
  await hooks(page);
  expect(await page.evaluate(() => window.__catman.view())).toBe('flat');
  await page.goto('/?s=view1&view=tilt');
  await hooks(page);
  expect(await page.evaluate(() => window.__catman.view())).toBe('tilt');
  await page.getByRole('button', { name: 'Switch to top-down view' }).click();
  expect(await page.evaluate(() => window.__catman.view())).toBe('flat');
  expect(errors).toEqual([]);
});

test('E2E 12 social: description, Open Graph and Twitter tags; og.png is a 1200×630 PNG; favicon served', async ({ page, request }) => {
  await page.goto('/');
  const meta = async (sel: string) => page.locator(sel).getAttribute('content');
  expect((await meta('meta[name="description"]'))!.length).toBeGreaterThan(50);
  for (const p of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type', 'og:image:alt']) expect(await meta(`meta[property="${p}"]`)).toBeTruthy();
  expect(await meta('meta[name="twitter:card"]')).toBe('summary_large_image');
  const img = await meta('meta[property="og:image"]');
  expect(img).toMatch(/^https:\/\/[^/]+\/og\.png$/); // crawlers need an absolute URL
  const res = await request.get('/og.png');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('image/png');
  const b = await res.body();
  // PNG signature, then IHDR width/height as big-endian u32 at bytes 16 and 20
  expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(b.readUInt32BE(16)).toBe(1200);
  expect(b.readUInt32BE(20)).toBe(630);
  expect(b.length).toBeLessThan(300_000);
  expect((await request.get('/favicon.svg')).status()).toBe(200);
});

test('E2E 13 boss telegraph: the variant emoji shows from bossIncoming through the fight, and clears on death', async ({ page }) => {
  await page.goto('/?s=golden1');
  await hooks(page);
  // the golden replay telegraphs boss 0 (plain) at tick 1229, spawns it at 1746, and dies to it at 2155
  const done = page.evaluate((l) => window.__catman.playLog(l), golden.levels);
  await page.waitForFunction(() => window.__catman.tick() >= 900);
  const early = await page.evaluate(() => ({ tick: window.__catman.tick(), icons: window.__catman.ui().bossIcons }));
  if (early.tick < 1229) expect(early.icons).toBeNull();
  await page.waitForFunction(() => window.__catman.tick() >= 1800);
  const fight = await page.evaluate(() => ({ tick: window.__catman.tick(), icons: window.__catman.ui().bossIcons }));
  expect(fight.tick).toBeLessThan(2155);
  expect(fight.icons).toBe('👑');
  await done;
  await page.waitForFunction(() => window.__catman.ui().screen === 'death');
  expect(await page.evaluate(() => window.__catman.ui().bossIcons)).toBeNull();
});
