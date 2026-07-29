/**
 * Ambient declarations for LlamaBlock.
 *
 * The background service worker is a classic (non-module) worker so it can pull in the
 * shared scripts with `importScripts`. `importScripts` lives in `lib.webworker.d.ts`,
 * which cannot be enabled alongside `lib.dom.d.ts` without a pile of conflicts — so it is
 * declared here instead.
 */

declare function importScripts(...urls: string[]): void;

/** Set by the test fixture pages in tests/fixtures/server.mjs. */
interface Window {
  __playResult: { settled: boolean; ok?: boolean; name?: string | null };
}
