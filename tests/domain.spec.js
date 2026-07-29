/**
 * Unit tests for shared/domain.js.
 *
 * Run inside the extension's own service worker rather than against a copy of the module,
 * so these exercise the exact code the extension ships and loads.
 */

import { test, expect } from './helpers.js';

/**
 * @param {import('./helpers.js').Extension} extension
 * @param {string} input
 * @returns {Promise<string | null>}
 */
function normalize(extension, input) {
  return extension.worker.evaluate((value) => LlamaVideoBlockDomain.normalize(value), input);
}

/**
 * @param {import('./helpers.js').Extension} extension
 * @param {string} url
 * @returns {Promise<string | null>}
 */
function fromUrl(extension, url) {
  return extension.worker.evaluate((value) => LlamaVideoBlockDomain.fromUrl(value), url);
}

/**
 * @param {import('./helpers.js').Extension} extension
 * @param {string[]} whitelist
 * @param {string} hostname
 * @returns {Promise<boolean>}
 */
function isWhitelisted(extension, whitelist, hostname) {
  return extension.worker.evaluate(
    ([list, host]) => LlamaVideoBlockDomain.isWhitelisted(list, host),
    /** @type {[string[], string]} */ ([whitelist, hostname]),
  );
}

test('normalize accepts bare domains, URLs, paths and ports', async ({ extension }) => {
  expect(await normalize(extension, 'netflix.com')).toBe('netflix.com');
  expect(await normalize(extension, 'www.netflix.com')).toBe('netflix.com');
  expect(await normalize(extension, 'NETFLIX.COM')).toBe('netflix.com');
  expect(await normalize(extension, '  netflix.com  ')).toBe('netflix.com');
  expect(await normalize(extension, 'https://www.netflix.com/browse')).toBe('netflix.com');
  expect(await normalize(extension, 'netflix.com/browse')).toBe('netflix.com');
  expect(await normalize(extension, 'netflix.com:8080')).toBe('netflix.com');
  expect(await normalize(extension, 'news.bbc.co.uk')).toBe('news.bbc.co.uk');
});

test('normalize rejects input that is not a web domain', async ({ extension }) => {
  expect(await normalize(extension, '')).toBeNull();
  expect(await normalize(extension, '   ')).toBeNull();
  expect(await normalize(extension, 'not a domain')).toBeNull();
  expect(await normalize(extension, 'chrome://settings')).toBeNull();
  expect(await normalize(extension, 'file:///Users/rob/video.mp4')).toBeNull();
  expect(await normalize(extension, 'javascript:alert(1)')).toBeNull();
});

test('normalize punycodes internationalised domains', async ({ extension }) => {
  expect(await normalize(extension, 'bücher.de')).toBe('xn--bcher-kva.de');
});

test('fromUrl only accepts http and https', async ({ extension }) => {
  expect(await fromUrl(extension, 'https://www.youtube.com/watch?v=abc')).toBe('youtube.com');
  expect(await fromUrl(extension, 'http://example.com')).toBe('example.com');
  expect(await fromUrl(extension, 'chrome://extensions')).toBeNull();
  expect(await fromUrl(extension, 'about:blank')).toBeNull();
  expect(await fromUrl(extension, 'nonsense')).toBeNull();
});

test('a whitelisted domain covers its subdomains (spec §2)', async ({ extension }) => {
  const list = ['netflix.com'];
  expect(await isWhitelisted(extension, list, 'netflix.com')).toBe(true);
  expect(await isWhitelisted(extension, list, 'media.netflix.com')).toBe(true);
  expect(await isWhitelisted(extension, list, 'a.b.netflix.com')).toBe(true);
});

test('whitelist matching does not leak across similar domains', async ({ extension }) => {
  const list = ['netflix.com'];
  // The classic suffix-matching bug: `endsWith` without the dot would allow this.
  expect(await isWhitelisted(extension, list, 'notnetflix.com')).toBe(false);
  expect(await isWhitelisted(extension, list, 'netflix.com.evil.test')).toBe(false);
  expect(await isWhitelisted(extension, list, 'example.com')).toBe(false);
});

test('an empty whitelist blocks everything (spec §4)', async ({ extension }) => {
  expect(await isWhitelisted(extension, [], 'netflix.com')).toBe(false);
});
