/**
 * Test harness for LlamaVideoBlock.
 *
 * Loads the unpacked extension into a real Chrome. Two things matter here:
 *
 *   1. `--autoplay-policy=no-user-gesture-required` disables Chrome's *own* autoplay
 *      blocking. Without it every "media did not play" assertion would pass whether or
 *      not LlamaVideoBlock did anything.
 *   2. Each test gets a throwaway profile directory, so whitelist and toggle state never
 *      leak between tests.
 */

import { test as base, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_PATH = dirname(dirname(fileURLToPath(import.meta.url)));

export const BASE_URL = 'http://127.0.0.1:8787';
/** The fixture server's hostname, as LlamaVideoBlock would store it in the whitelist. */
export const FIXTURE_DOMAIN = '127.0.0.1';

/**
 * @typedef {object} Extension
 * @property {import('@playwright/test').BrowserContext} context
 * @property {import('@playwright/test').Worker} worker background service worker
 * @property {string} id extension id
 */

/** @typedef {{ extension: Extension }} LlamaVideoBlockFixtures */
/** @typedef {import('@playwright/test').PlaywrightTestArgs & import('@playwright/test').PlaywrightTestOptions} BaseTestArgs */
/** @typedef {import('@playwright/test').PlaywrightWorkerArgs & import('@playwright/test').PlaywrightWorkerOptions} BaseWorkerArgs */

export const test = base.extend(
  /** @type {import('@playwright/test').Fixtures<LlamaVideoBlockFixtures, {}, BaseTestArgs, BaseWorkerArgs>} */ ({
    /**
     * A Chrome running the unpacked extension, with blocking at its installed defaults.
     * Each test gets a throwaway profile so whitelist and toggle state never leak between
     * tests.
     */
    // Playwright reads this signature to work out fixture dependencies, so the empty
    // destructuring pattern is required — it cannot be a named parameter.
    extension: async ({}, use) => {
      const profile = await mkdtemp(join(tmpdir(), 'llamavideoblock-'));

      const context = await chromium.launchPersistentContext(profile, {
        // Extensions need the full Chromium build, not the headless shell.
        channel: 'chromium',
        args: [
          `--disable-extensions-except=${EXTENSION_PATH}`,
          `--load-extension=${EXTENSION_PATH}`,
          '--autoplay-policy=no-user-gesture-required',
        ],
      });

      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const id = new URL(worker.url()).host;

      await use({ context, worker, id });

      await context.close();
      await rm(profile, { recursive: true, force: true });
    },
  }),
);

export { expect };

/**
 * Write settings the way the popup and options page would, before a page loads.
 *
 * Runs inside the service worker, which is a trusted extension context with access to
 * every storage area.
 *
 * @param {Extension} extension
 * @param {{ enabled?: boolean, whitelist?: string[] }} settings
 * @returns {Promise<void>}
 */
export async function setSettings(extension, settings) {
  await extension.worker.evaluate(async (values) => {
    if (values.enabled !== undefined) {
      await chrome.storage.local.set({ enabled: values.enabled });
    }
    if (values.whitelist !== undefined) {
      await chrome.storage.sync.set({ whitelist: values.whitelist });
    }
  }, settings);
}

/**
 * The blocked-play tally the background worker has recorded, summed across every frame.
 *
 * @param {Extension} extension
 * @returns {Promise<number>}
 */
export async function totalBlockedCount(extension) {
  return extension.worker.evaluate(async () => {
    const stored = await chrome.storage.session.get('blockCounts');
    const counts = stored.blockCounts ?? {};
    let total = 0;
    for (const frames of Object.values(counts)) {
      for (const value of Object.values(frames)) total += value;
    }
    return total;
  });
}

/**
 * Snapshot of a media element, taken after giving it a fair chance to start.
 *
 * @param {import('@playwright/test').Page | import('@playwright/test').FrameLocator} scope
 * @param {string} selector
 * @returns {Promise<{ paused: boolean, currentTime: number, autoplayAttr: boolean, preload: string }>}
 */
export async function mediaState(scope, selector) {
  return scope.locator(selector).evaluate((element) => {
    if (!(element instanceof HTMLMediaElement)) throw new Error('not a media element');
    return {
      paused: element.paused,
      currentTime: element.currentTime,
      autoplayAttr: element.hasAttribute('autoplay'),
      preload: element.getAttribute('preload') ?? '',
    };
  });
}

/**
 * Media is asynchronous: an element that is going to autoplay needs a moment to fetch and
 * decode before `paused` flips. Waiting a fixed beat before asserting "still paused" is
 * what makes the negative assertion meaningful.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<void>}
 */
export async function settle(page) {
  await page.waitForTimeout(1200);
}

/**
 * How the fixture page's `play()` promise settled.
 *
 * Waits for it rather than reading once. `paused` flips to false slightly before the
 * promise resolves, so a test that polls on `paused` and then reads this immediately can
 * catch it mid-flight — which showed up as an intermittent failure.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ settled: boolean, ok?: boolean, name?: string | null }>}
 */
export async function playResult(page) {
  await expect
    .poll(() => page.evaluate(() => window.__playResult.settled), {
      message: 'the page\'s play() promise should settle',
    })
    .toBe(true);
  return page.evaluate(() => window.__playResult);
}
