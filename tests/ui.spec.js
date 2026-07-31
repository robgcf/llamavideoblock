/**
 * Popup and options page behaviour.
 *
 * These exist because visibility bugs are invisible to the blocking tests: an element
 * toggled with the `hidden` property still shows if an author `display` rule outranks the
 * UA stylesheet, and nothing in the extension's logic would notice.
 */

import { test, expect, setSettings, BASE_URL, settle } from './helpers.js';

/**
 * The popup reads the toolbar's owning tab. Opening popup.html directly as a tab would
 * make it inspect itself, so `chrome.tabs` is stood in for. Everything else — storage,
 * rendering, the whitelist logic — is the real thing.
 *
 * @param {import('./helpers.js').Extension} extension
 * @param {string} tabUrl
 * @param {number} [tabId] the tab the popup should believe it is attached to
 * @returns {Promise<import('@playwright/test').Page>}
 */
async function openPopup(extension, tabUrl, tabId = 42) {
  const page = await extension.context.newPage();
  await page.addInitScript(
    ([url, id]) => {
      // Only the two fields the popup reads; the rest of chrome.tabs.Tab is irrelevant.
      const tabs = /** @type {chrome.tabs.Tab[]} */ (
        /** @type {unknown} */ ([{ id, url }])
      );
      chrome.tabs.query = async () => tabs;
      chrome.tabs.reload = async () => {};
    },
    /** @type {[string, number]} */ ([tabUrl, tabId]),
  );
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

test('diagnostics toggle is off by default and persists when turned on', async ({
  extension,
}) => {
  const page = await openOptions(extension);

  await expect(page.locator('#debug-toggle')).not.toBeChecked();

  // The input is visually hidden behind its styled box, so click the label the way a
  // user would rather than the input itself.
  await page.click('label[for="debug-toggle"]');
  await expect
    .poll(() => extension.worker.evaluate(() => chrome.storage.local.get('debug')))
    .toEqual({ debug: true });

  // Survives a reload — it is a setting, not page state.
  await page.reload();
  await expect(page.locator('#debug-toggle')).toBeChecked();

  // The input is visually hidden behind its styled box, so click the label the way a
  // user would rather than the input itself.
  await page.click('label[for="debug-toggle"]');
  await expect
    .poll(() => extension.worker.evaluate(() => chrome.storage.local.get('debug')))
    .toEqual({ debug: false });
});

test('debug logging stays silent unless the toggle is on', async ({ extension }) => {
  const page = await extension.context.newPage();
  /** @type {string[]} */
  const logs = [];
  page.on('console', (message) => {
    if (message.text().includes('LlamaAutoPlayBlock')) logs.push(message.text());
  });

  await page.goto(`${BASE_URL}/attr-video`);
  await settle(page);
  expect(logs).toEqual([]);

  // And speaks up when it is on.
  await extension.worker.evaluate(async () => chrome.storage.local.set({ debug: true }));
  await page.reload();
  await settle(page);
  expect(logs.join('\n')).toContain('verdict for 127.0.0.1');
});

test('popup surfaces the decision log so diagnosing needs no DevTools', async ({
  extension,
}) => {
  await extension.worker.evaluate(async () => chrome.storage.local.set({ debug: true }));

  // A real page load, so the lines come from the blocker rather than being planted.
  const site = await extension.context.newPage();
  await site.goto(`${BASE_URL}/attr-video`);
  await settle(site);

  const tabId = await extension.worker.evaluate(async () => {
    const stored = await chrome.storage.session.get('debugLines');
    return Object.keys(stored.debugLines ?? {})[0];
  });
  expect(tabId, 'the content script should have reported decisions').toBeDefined();

  const popup = await openPopup(extension, `${BASE_URL}/attr-video`, Number(tabId));
  await expect(popup.locator('#diag')).toBeVisible();
  await expect(popup.locator('#diag-log')).toContainText('verdict received');
  await expect(popup.locator('#diag-log')).toContainText('autoplay attribute STRIPPED');
});

test('popup hides the decision log when diagnostics are off', async ({ extension }) => {
  const popup = await openPopup(extension, 'https://www.youtube.com/watch?v=abc');
  await expect(popup.locator('#diag')).toBeHidden();
});

test('options page links to the privacy policy', async ({ extension }) => {
  // Chrome Web Store review requires a privacy policy because of <all_urls>. The link is
  // asserted here so a refactor cannot quietly drop it; whether the page is actually
  // published is a release-checklist item, not something a test can know.
  const page = await openOptions(extension);
  const link = page.locator('.colophon__link');

  await expect(link).toHaveAttribute(
    'href',
    'https://llamahub.net/legal/llamaautoplayblock-privacy',
  );
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});

test('options page follows whitelist changes made elsewhere', async ({ extension }) => {
  const page = await openOptions(extension);
  await expect(page.locator('#empty')).toBeVisible();

  // Stands in for the popup, another open copy of this page, or sync from another device.
  await setSettings(extension, { whitelist: ['twitch.tv'] });

  await expect(page.locator('.row__domain')).toHaveText(['twitch.tv']);
  await expect(page.locator('#empty')).toBeHidden();
});
