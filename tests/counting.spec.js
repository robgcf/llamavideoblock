/**
 * Blocked-play tally (spec §10) — the number the popup shows.
 *
 * The path under test spans all three contexts: the MAIN-world blocker counts, posts to
 * the ISOLATED world, which messages the background worker, which writes session storage.
 */

import { test, expect, BASE_URL, FIXTURE_DOMAIN, setSettings, totalBlockedCount, settle } from './helpers.js';

test('counts each blocked element once and reports it to the background', async ({
  extension,
}) => {
  const page = await extension.context.newPage();
  await page.goto(`${BASE_URL}/two-videos`);
  await settle(page);

  await expect
    .poll(() => totalBlockedCount(extension), { message: 'two blocked autoplays recorded' })
    .toBe(2);
});

test('counts nothing on a whitelisted domain', async ({ extension }) => {
  await setSettings(extension, { whitelist: [FIXTURE_DOMAIN] });

  const page = await extension.context.newPage();
  await page.goto(`${BASE_URL}/two-videos`);
  await settle(page);

  expect(await totalBlockedCount(extension)).toBe(0);
});

test('clears the tally when the tab navigates', async ({ extension }) => {
  const page = await extension.context.newPage();
  await page.goto(`${BASE_URL}/two-videos`);
  await expect.poll(() => totalBlockedCount(extension)).toBe(2);

  await page.goto(`${BASE_URL}/attr-video`);
  await settle(page);

  await expect
    .poll(() => totalBlockedCount(extension), { message: 'tally resets for the new document' })
    .toBe(1);
});
