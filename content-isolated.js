/**
 * LlamaBlock — ISOLATED-world bridge.
 *
 * `content-main.js` blocks first and asks later. This is the "later": read the whitelist
 * and master toggle, work out whether this frame should be blocking, and tell the MAIN
 * world. It also carries blocked counts the other way, since the MAIN world has no access
 * to `chrome.*`.
 *
 * Loaded after `shared/domain.js` and `shared/store.js`, which share this world's scope.
 *
 * @see docs/superpowers/specs/2026-07-29-llamablock-design.md
 */

(() => {
  'use strict';

  const VERDICT_CHANNEL = 'llamablock:verdict';
  const COUNT_CHANNEL = 'llamablock:count';
  /** The count is cosmetic and page-visible, so clamp rather than trust it. */
  const MAX_REPORTED_COUNT = 9999;

  /**
   * The hostname whose whitelist entry governs this frame.
   *
   * `about:blank` and `about:srcdoc` frames have no host of their own but inherit their
   * embedder's origin, so they fall back to the nearest http(s) ancestor. Without this,
   * a whitelisted site's blank iframes would still be blocked.
   *
   * @returns {string | null}
   */
  function currentHostname() {
    const own = LlamaBlockDomain.fromUrl(location.href);
    if (own) return own;

    const ancestors = location.ancestorOrigins;
    if (!ancestors) return null;

    // Index 0 is the immediate parent, so this walks outward and takes the nearest match.
    for (let i = 0; i < ancestors.length; i++) {
      const host = LlamaBlockDomain.fromUrl(ancestors.item(i));
      if (host) return host;
    }
    return null;
  }

  /**
   * @returns {boolean} true if the extension context is still live. Reloading the
   *   extension invalidates content scripts in already-open tabs, and every `chrome.*`
   *   call from them throws afterwards.
   */
  function contextIsValid() {
    return Boolean(chrome.runtime?.id);
  }

  /**
   * @param {boolean} blocking
   * @returns {void}
   */
  function sendVerdict(blocking) {
    window.postMessage({ channel: VERDICT_CHANNEL, blocking }, '*');
  }

  /**
   * Decide, and tell the MAIN world. Any failure leaves the page blocked — the MAIN world
   * is already in that state, so an unsent verdict is itself the safe outcome, but we send
   * an explicit block so it can drop its undo log instead of holding it for five seconds.
   *
   * @returns {Promise<void>}
   */
  async function resolveVerdict() {
    try {
      const { enabled, whitelist } = await LlamaBlockStore.getSettings();
      const hostname = currentHostname();
      sendVerdict(enabled && !LlamaBlockDomain.isWhitelisted(whitelist, hostname));
    } catch (error) {
      console.error('[LlamaBlock] Could not resolve verdict, staying blocked:', error);
      sendVerdict(true);
    }
  }

  /**
   * @param {number} count
   * @returns {void}
   */
  function reportCount(count) {
    if (!contextIsValid()) return;
    try {
      const message = { type: 'blockedCount', count };
      // Rejects if the service worker is mid-restart; the next report supersedes it.
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch (error) {
      console.error('[LlamaBlock] Could not report blocked count:', error);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    const data = event.data;
    if (!data || typeof data !== 'object' || data.channel !== COUNT_CHANNEL) return;

    const count = Number(data.count);
    if (!Number.isFinite(count) || count < 0) return;
    reportCount(Math.min(Math.floor(count), MAX_REPORTED_COUNT));
  });

  void resolveVerdict();
})();
