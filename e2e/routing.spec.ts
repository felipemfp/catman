// ghost-api T-A7: runs against wrangler dev, because the vitest plugin's SELF.fetch skips static assets.
import { expect, test } from '@playwright/test';

test('T-A7 /api is never swallowed by assets', async ({ request, browserName }) => {
  test.skip(browserName !== 'chromium', 'HTTP-only check, once is enough');
  const miss = await request.get('/api/ghost/ZZZZZZZZ');
  expect(miss.status()).toBe(404);
  expect(miss.headers()['content-type']).toContain('application/json');
  const nofile = await request.get('/no-such-file');
  expect(nofile.status()).toBe(404);
  expect(await nofile.text()).toBe('Not found');
  const root = await request.get('/');
  expect(root.status()).toBe(200);
  expect(await root.text()).toContain('<title>Catman</title>');
});
