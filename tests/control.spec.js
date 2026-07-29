/**
 * The control group.
 *
 * These tests prove the fixtures genuinely autoplay when LlamaVideoBlock stands down. Without
 * them, every assertion in blocking.spec.js could pass for the wrong reason — a broken
 * fixture, a missing media file, or an extension that failed to load would all look like
 * successful blocking.
 */

import {
  test, expect, BASE_URL, FIXTURE_DOMAIN, setSettings, mediaState, settle, playResult,
} from './helpers.js';

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<void>}
 */
async function expectPlaying(page) {
  await expect
    .poll(async () => (await mediaState(page, '#media')).paused, {
      message: 'media should be playing',
    })
    .toBe(false);
}

test('autoplays normally when the master toggle is off (spec §5)', async ({ extension }) => {
  await setSettings(extension, { enabled: false });

  const page = await extension.context.newPage();
  await page.goto(`${BASE_URL}/attr-video`);

  await expectPlaying(page);
  // The site's own markup is left untouched when LlamaVideoBlock stands down.
  expect((await mediaState(page, '#media')).autoplayAttr).toBe(true);
});

test('autoplays normally on a whitelisted domain (spec §2)', async ({ extension }) => {
  await setSettings(extension, { whitelist: [FIXTURE_DOMAIN] });

  const page = await extension.context.newPage();
  await page.goto(`${BASE_URL}/attr-video`);

  await expectPlaying(page);
});

test('allows a JS-initiated play() on a whitelisted domain', async ({ extension }) => {
  await setSettings(extension, { whitelist: [FIXTURE_DOMAIN] });

  const page = await extension.context.newPage();
  await page.goto(`${BASE_URL}/js-play`);
  await settle(page);

  const result = await playResult(page);
  expect(result.ok).toBe(true);
  expect((await mediaState(page, '#media')).paused).toBe(false);
});

test('blocks again once the domain is removed from the whitelist', async ({ extension }) => {
  await setSettings(extension, { whitelist: [FIXTURE_DOMAIN] });

  const page = await extension.context.newPage();
  await page.goto(`${BASE_URL}/attr-video`);
  await expectPlaying(page);

  await setSettings(extension, { whitelist: [] });
  await page.reload();
  await settle(page);

  expect((await mediaState(page, '#media')).paused).toBe(true);
});

test('an unrelated whitelist entry does not unblock this site', async ({ extension }) => {
  await setSettings(extension, { whitelist: ['example.com', 'netflix.com'] });

  const page = await extension.context.newPage();
  await page.goto(`${BASE_URL}/attr-video`);
  await settle(page);

  expect((await mediaState(page, '#media')).paused).toBe(true);
});
