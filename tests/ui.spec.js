/**
 * Popup and options page behaviour.
 *
 * These exist because visibility bugs are invisible to the blocking tests: an element
 * toggled with the `hidden` property still shows if an author `display` rule outranks the
 * UA stylesheet, and nothing in the extension's logic would notice.
 */

import { test, expect, setSettings } from './helpers.js';

/**
 * The popup reads the toolbar's owning tab. Opening popup.html directly as a tab would
 * make it inspect itself, so `chrome.tabs` is stood in for. Everything else — storage,
 * rendering, the whitelist logic — is the real thing.
 *
 * @param {import('./helpers.js').Extension} extension
 * @param {string} tabUrl
 * @returns {Promise<import('@playwright/test').Page>}
 */
async function openPopup(extension, tabUrl) {
  const page = await extension.context.newPage();
  await page.addInitScript((url) => {
    // Only the two fields the popup reads; the rest of chrome.tabs.Tab is irrelevant here.
    const tabs = /** @type {chrome.tabs.Tab[]} */ (
      /** @type {unknown} */ ([{ id: 42, url }])
    );
    chrome.tabs.query = async () => tabs;
    chrome.tabs.reload = async () => {};
  }, tabUrl);
  await page.goto(`chrome-extension://${extension.id}/popup/popup.html`);
  return page;
}

/**
 * @param {import('./helpers.js').Extension} extension
 * @returns {Promise<import('@playwright/test').Page>}
 */
async function openOptions(extension) {
  const page = await extension.context.newPage();
  await page.goto(`chrome-extension://${extension.id}/options/options.html`);
  return page;
}

test('popup shows the blocked tally on a blocked site', async ({ extension }) => {
  await extension.worker.evaluate(async () => {
    await chrome.storage.session.set({ blockCounts: { 42: { 0: 3 } } });
  });

  const page = await openPopup(extension, 'https://www.youtube.com/watch?v=abc');

  await expect(page.locator('#site-host')).toHaveText('youtube.com');
  await expect(page.locator('#site-pill')).toHaveText('Blocked');
  await expect(page.locator('#tally')).toBeVisible();
  await expect(page.locator('#tally-value')).toHaveText('3');
  await expect(page.locator('#tally-label')).toHaveText('autoplays blocked here');
  await expect(page.locator('#whitelist-toggle')).toHaveText('Whitelist this site');
});

test('popup hides the tally on a whitelisted site', async ({ extension }) => {
  await setSettings(extension, { whitelist: ['netflix.com'] });

  const page = await openPopup(extension, 'https://www.netflix.com/browse');

  await expect(page.locator('#site-pill')).toHaveText('Allowed');
  await expect(page.locator('#tally')).toBeHidden();
  await expect(page.locator('#whitelist-toggle')).toHaveText(
    'Remove netflix.com from whitelist',
  );
});

test('popup disables the whitelist button while the master toggle is off', async ({
  extension,
}) => {
  await setSettings(extension, { enabled: false });

  const page = await openPopup(extension, 'https://news.bbc.co.uk/story');

  await expect(page.locator('#master-toggle')).not.toBeChecked();
  await expect(page.locator('#site-pill')).toHaveText('Off');
  await expect(page.locator('#whitelist-toggle')).toBeDisabled();
  await expect(page.locator('#tally')).toBeHidden();
});

test('popup reports that it cannot act on non-web pages', async ({ extension }) => {
  const page = await openPopup(extension, 'chrome://settings');

  await expect(page.locator('#site-host')).toHaveText('Not a web page');
  await expect(page.locator('#site-pill')).toHaveText('N/A');
  await expect(page.locator('#whitelist-toggle')).toBeHidden();
  await expect(page.locator('#tally')).toBeHidden();
});

test('popup whitelists the current site', async ({ extension }) => {
  const page = await openPopup(extension, 'https://www.youtube.com/watch?v=abc');

  await page.click('#whitelist-toggle');

  await expect(page.locator('#site-pill')).toHaveText('Allowed');
  expect(await extension.worker.evaluate(() => chrome.storage.sync.get('whitelist'))).toEqual({
    whitelist: ['youtube.com'],
  });
});

test('options page shows an empty state before anything is whitelisted', async ({
  extension,
}) => {
  const page = await openOptions(extension);

  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#list-count')).toHaveText('0');
  // Nothing to clear, so the whole row stays out of the way.
  await expect(page.locator('#clear-row')).toBeHidden();
});

test('options page lists whitelisted domains and removes them', async ({ extension }) => {
  await setSettings(extension, { whitelist: ['netflix.com', 'vimeo.com'] });

  const page = await openOptions(extension);

  await expect(page.locator('#empty')).toBeHidden();
  await expect(page.locator('#list-count')).toHaveText('2');
  await expect(page.locator('.row__domain')).toHaveText(['netflix.com', 'vimeo.com']);

  await page.click('button[aria-label="Remove netflix.com from the whitelist"]');
  await expect(page.locator('.row__domain')).toHaveText(['vimeo.com']);
});

test('options page adds a domain and normalises it', async ({ extension }) => {
  const page = await openOptions(extension);

  await page.fill('#add-input', 'https://www.Netflix.com/browse');
  await page.click('button[type="submit"]');

  await expect(page.locator('.row__domain')).toHaveText(['netflix.com']);
  await expect(page.locator('#add-input')).toHaveValue('');
  await expect(page.locator('#add-error')).toBeHidden();
});

test('options page rejects input that is not a domain', async ({ extension }) => {
  const page = await openOptions(extension);

  await page.fill('#add-input', 'not a domain');
  await page.click('button[type="submit"]');

  await expect(page.locator('#add-error')).toBeVisible();
  await expect(page.locator('#add-error')).toContainText('is not a domain');
  await expect(page.locator('.row__domain')).toHaveCount(0);
});

test('options page refuses a domain already covered by a parent entry', async ({
  extension,
}) => {
  await setSettings(extension, { whitelist: ['netflix.com'] });

  const page = await openOptions(extension);
  await page.fill('#add-input', 'media.netflix.com');
  await page.click('button[type="submit"]');

  await expect(page.locator('#add-error')).toContainText('already covered by netflix.com');
  await expect(page.locator('.row__domain')).toHaveCount(1);
});

test('clear all needs a second, deliberate confirmation', async ({ extension }) => {
  await setSettings(extension, { whitelist: ['netflix.com', 'vimeo.com'] });

  const page = await openOptions(extension);

  // The confirmation must not be showing until asked for.
  await expect(page.locator('#confirm')).toBeHidden();
  await expect(page.locator('#clear')).toBeVisible();

  await page.click('#clear');
  await expect(page.locator('#confirm')).toBeVisible();
  await expect(page.locator('.row__domain')).toHaveCount(2);

  // Backing out leaves the list alone.
  await page.click('#clear-cancel');
  await expect(page.locator('#confirm')).toBeHidden();
  await expect(page.locator('.row__domain')).toHaveCount(2);

  await page.click('#clear');
  await page.click('#clear-confirm');
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('.row__domain')).toHaveCount(0);
});

test('options page follows whitelist changes made elsewhere', async ({ extension }) => {
  const page = await openOptions(extension);
  await expect(page.locator('#empty')).toBeVisible();

  // Stands in for the popup, another open copy of this page, or sync from another device.
  await setSettings(extension, { whitelist: ['twitch.tv'] });

  await expect(page.locator('.row__domain')).toHaveText(['twitch.tv']);
  await expect(page.locator('#empty')).toBeHidden();
});
