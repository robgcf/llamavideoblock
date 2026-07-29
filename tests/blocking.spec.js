/**
 * Core blocking behaviour (spec §2, §3).
 *
 * Every "did not play" assertion in this file is only meaningful because
 * `control.spec.js` proves the same fixtures *do* autoplay when LlamaVideoBlock stands down.
 * Read the two files together.
 */

import { test, expect, BASE_URL, mediaState, settle } from './helpers.js';

test('pauses a video with the autoplay attribute and strips the attribute', async ({
  extension,
}) => {
  const page = await extension.context.newPage();
  await page.goto(`${BASE_URL}/attr-video`);
  await settle(page);

  const state = await mediaState(page, '#media');
  expect(state.paused).toBe(true);
  expect(state.currentTime).toBe(0);
  expect(state.autoplayAttr).toBe(false);
  // Forced so the element renders a real frame rather than black (design §3).
  expect(state.preload).toBe('metadata');
});

test('pauses an audio element with the autoplay attribute', async ({ extension }) => {
  const page = await extension.context.newPage();
  await page.goto(`${BASE_URL}/attr-audio`);
  await settle(page);

  const state = await mediaState(page, '#media');
  expect(state.paused).toBe(true);
  expect(state.autoplayAttr).toBe(false);
});

test('rejects a JS-initiated play() with NotAllowedError', async ({ extension }) => {
  const page = await extension.context.newPage();
  await page.goto(`${BASE_URL}/js-play`);
  await settle(page);

  const result = await page.evaluate(() => window.__playResult);
  expect(result.settled).toBe(true);
  expect(result.ok).toBe(false);
  // The exact error Chrome's own autoplay policy throws. Sites already handle it, so they
  // fall back to a play button instead of breaking.
  expect(result.name).toBe('NotAllowedError');

  expect((await mediaState(page, '#media')).paused).toBe(true);
});

test('pauses media injected long after load (the SPA case)', async ({ extension }) => {
  const page = await extension.context.newPage();
  await page.goto(`${BASE_URL}/dynamic`);
  await page.waitForSelector('#media');
  await settle(page);

  const state = await mediaState(page, '#media');
  expect(state.paused).toBe(true);
  expect(state.autoplayAttr).toBe(false);
});

test('blocks media inside a same-origin iframe', async ({ extension }) => {
  const page = await extension.context.newPage();
  await page.goto(`${BASE_URL}/framed`);
  await settle(page);

  const state = await mediaState(page.frameLocator('#frame'), '#media');
  expect(state.paused).toBe(true);
});

test('allows playback started by a real user click', async ({ extension }) => {
  const page = await extension.context.newPage();
  await page.goto(`${BASE_URL}/user-click`);
  await settle(page);

  // Blocked up to this point...
  expect((await mediaState(page, '#media')).paused).toBe(true);

  await page.click('#go');
  await expect
    .poll(async () => (await mediaState(page, '#media')).paused, {
      message: 'video should play after a user click',
    })
    .toBe(false);

  const result = await page.evaluate(() => window.__playResult);
  expect(result.ok).toBe(true);
});
