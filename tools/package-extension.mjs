/**
 * Build the Chrome Web Store upload zip.
 *
 * Works from an explicit allow-list rather than by excluding things. An exclude-based
 * `zip -r` is how `.env` files, source maps, and node_modules end up in a public
 * submission; if a new source file is added it should have to be named here.
 *
 * Also cross-checks that every path the manifest references is actually in the bundle, so
 * a forgotten file fails here rather than at review.
 *
 * Usage: npm run package
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'dist');

/** Everything that ships. Dev tooling, tests, docs and types are deliberately absent. */
const SHIPPED = [
  'manifest.json',
  'background.js',
  'content-main.js',
  'content-isolated.js',
  'shared/domain.js',
  'shared/store.js',
  'shared/theme.css',
  'popup/popup.html',
  'popup/popup.js',
  'popup/popup.css',
  'options/options.html',
  'options/options.js',
  'options/options.css',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'icons/icon16-gray.png',
  'icons/icon32-gray.png',
  'icons/icon48-gray.png',
  'icons/icon128-gray.png',
];

/**
 * Every extension-relative path the manifest points at.
 *
 * @param {Record<string, unknown>} manifest
 * @returns {string[]}
 */
function manifestReferences(manifest) {
  /** @type {string[]} */
  const paths = [];

  /**
   * @param {unknown} value
   * @returns {void}
   */
  function walk(value) {
    if (typeof value === 'string') {
      // Extension-relative asset paths, as opposed to match patterns and version strings.
      if (/\.(js|css|html|png)$/.test(value)) paths.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item);
    }
  }

  walk(manifest);
  return [...new Set(paths)];
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

const missing = SHIPPED.filter((file) => !existsSync(join(ROOT, file)));
if (missing.length > 0) {
  console.error(`Missing files listed in SHIPPED:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const unbundled = manifestReferences(manifest).filter((file) => !SHIPPED.includes(file));
if (unbundled.length > 0) {
  console.error(
    `manifest.json references files that SHIPPED does not include:\n  ${unbundled.join('\n  ')}`,
  );
  process.exit(1);
}

const output = join(DIST, `llamablock-${manifest.version}.zip`);
mkdirSync(DIST, { recursive: true });
rmSync(output, { force: true });

// -X drops extended attributes and resource forks, which macOS would otherwise add.
execFileSync('zip', ['-X', '-q', output, ...SHIPPED], { cwd: ROOT });

console.log(`Packaged ${SHIPPED.length} files -> ${output}`);
console.log(`Version ${manifest.version}. Upload this to the Chrome Web Store.`);
