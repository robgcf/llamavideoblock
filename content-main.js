/**
 * LlamaBlock — MAIN-world autoplay blocker.
 *
 * Runs at `document_start` in the page's own JavaScript world, which means it executes
 * before any page script. That ordering is the whole point: overriding
 * `HTMLMediaElement.prototype.play` only works if we get there before YouTube's player
 * captures the original function.
 *
 * This script starts blocking unconditionally and asks no questions. `content-isolated.js`
 * reads the whitelist and posts a verdict a millisecond or so later; until it arrives we
 * block, and if it never arrives we keep blocking. Blocking is the safe failure mode and
 * matches the spec's installed default.
 *
 * If the verdict says "allowed", everything done in that window is undone: stripped
 * `autoplay` attributes go back, rejected `play()` calls are re-issued, paused media
 * resumes.
 *
 * Three layers do the blocking, because no single hook catches everything:
 *   1. `play()` override        — JS-initiated autoplay (how every modern player works)
 *   2. `autoplay` attr stripping — declarative autoplay, including SPA-injected elements
 *   3. capture-phase `play` net  — anything the first two miss
 *
 * @see docs/superpowers/specs/2026-07-29-llamablock-design.md
 */

(() => {
  'use strict';

  const VERDICT_CHANNEL = 'llamablock:verdict';
  const COUNT_CHANNEL = 'llamablock:count';

  /** Give up waiting for a verdict and stay blocked. Storage reads take ~1ms in practice. */
  const VERDICT_TIMEOUT_MS = 5000;
  /** Coalesce count reports so a page full of media doesn't spam the service worker. */
  const COUNT_REPORT_DELAY_MS = 250;
  /** Ceiling on the undo log, in case a verdict never lands on a media-heavy page. */
  const MAX_TRACKED_ELEMENTS = 500;

  /** True until a verdict says otherwise. Fail closed. */
  let blocking = true;
  /** Once settled, the verdict is final for this document's lifetime. */
  let settled = false;
  let blockedCount = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let countReportTimer = null;

  // Captured before page script gets a chance to replace them, so our own bookkeeping
  // can't be observed or hijacked by the page.
  const mediaProto = HTMLMediaElement.prototype;
  const nativePlay = mediaProto.play;
  const nativePause = mediaProto.pause;
  const getAttribute = Element.prototype.getAttribute;
  const setAttribute = Element.prototype.setAttribute;
  const removeAttribute = Element.prototype.removeAttribute;
  const hasAttribute = Element.prototype.hasAttribute;
  const querySelectorAll = Element.prototype.querySelectorAll;

  /**
   * What a media element looked like before we touched it, so an "allowed" verdict can
   * put it back. Only populated before the verdict settles, and capped.
   *
   * @typedef {{ autoplay: boolean, preload: string | null, wantedPlay: boolean }} Original
   * @type {Map<HTMLMediaElement, Original>}
   */
  const originals = new Map();

  /** Counted once per element, so the popup shows "autoplays blocked", not "calls blocked". */
  const counted = new WeakSet();

  /**
   * `play()` calls made before the verdict landed, held open until we know the answer.
   *
   * Rejecting them immediately would be wrong: a site that calls `play()` during parsing
   * — which is most of them — would be told autoplay was refused even on a whitelisted
   * domain, and would show its "click to play" fallback over a video that then started
   * anyway. A promise resolved a millisecond late costs nothing; `play()` is async
   * regardless.
   *
   * @type {Array<() => void>}
   */
  const deferredPlays = [];

  // ---------------------------------------------------------------------------
  // Layer 1: play() override. Installed first, before anything else can run.
  // ---------------------------------------------------------------------------

  /**
   * Chrome's own autoplay-policy rejection, reproduced exactly. Every real player already
   * handles this error, so sites fall back to showing a play button instead of breaking
   * or spinning in a retry loop.
   *
   * @returns {DOMException}
   */
  function notAllowedError() {
    return new DOMException(
      "play() failed because the user didn't interact with the document first.",
      'NotAllowedError',
    );
  }

  /**
   * Best available signal for "a human caused this". Correctly false during page load and
   * true for a real click. Transient activation lasts a few seconds, so a site can slip an
   * autoplay through shortly after an unrelated click — an accepted trade, since without
   * this check every play button on the web would break.
   *
   * @returns {boolean}
   */
  function hasUserActivation() {
    return navigator.userActivation?.isActive === true;
  }

  mediaProto.play = function play() {
    if (!blocking || hasUserActivation()) return nativePlay.call(this);

    // `wantedPlay` stays false: if the verdict turns out to be "allowed", this element is
    // started by its own deferred promise below rather than by the bulk restore.
    remember(this, false);
    countBlocked(this);
    stripAutoplay(this);

    if (settled || deferredPlays.length >= MAX_TRACKED_ELEMENTS) {
      return Promise.reject(notAllowedError());
    }

    const element = this;
    return new Promise((resolve, reject) => {
      deferredPlays.push(() => {
        if (blocking) {
          reject(notAllowedError());
          return;
        }
        nativePlay.call(element).then(resolve, reject);
      });
    });
  };

  // ---------------------------------------------------------------------------
  // Undo log
  // ---------------------------------------------------------------------------

  /**
   * Snapshot an element's pre-LlamaBlock state. No-op once the verdict has settled —
   * at that point we either block for good or have already restored everything.
   *
   * @param {HTMLMediaElement} element
   * @param {boolean} wantedPlay whether the page actively asked this element to play
   * @returns {void}
   */
  function remember(element, wantedPlay) {
    if (settled) return;

    const existing = originals.get(element);
    if (existing) {
      if (wantedPlay) existing.wantedPlay = true;
      return;
    }
    if (originals.size >= MAX_TRACKED_ELEMENTS) return;

    originals.set(element, {
      autoplay: hasAttribute.call(element, 'autoplay'),
      preload: getAttribute.call(element, 'preload'),
      wantedPlay,
    });
  }

  // ---------------------------------------------------------------------------
  // Suppression
  // ---------------------------------------------------------------------------

  /**
   * Remove `autoplay` and force a metadata preload so the element renders a real frame
   * instead of black. Never downgrades a preload the site already asked for.
   *
   * @param {HTMLMediaElement} element
   * @returns {void}
   */
  function stripAutoplay(element) {
    if (hasAttribute.call(element, 'autoplay')) {
      removeAttribute.call(element, 'autoplay');
    }

    const preload = (getAttribute.call(element, 'preload') ?? '').toLowerCase();
    if (preload !== 'metadata' && preload !== 'auto') {
      setAttribute.call(element, 'preload', 'metadata');
    }
  }

  /**
   * @param {HTMLMediaElement} element
   * @returns {void}
   */
  function countBlocked(element) {
    if (counted.has(element)) return;
    counted.add(element);
    blockedCount += 1;
    scheduleCountReport();
  }

  /**
   * Handle a media element we have just become aware of.
   *
   * @param {HTMLMediaElement} element
   * @returns {void}
   */
  function handleMedia(element) {
    if (!blocking) return;

    const declaredAutoplay = hasAttribute.call(element, 'autoplay');
    if (declaredAutoplay) {
      remember(element, false);
      countBlocked(element);
      stripAutoplay(element);
    }

    // Media may already have started between insertion and this callback.
    if (!element.paused && !hasUserActivation()) {
      remember(element, true);
      countBlocked(element);
      nativePause.call(element);
    }
  }

  /**
   * @param {Node} node
   * @returns {void}
   */
  function scanNode(node) {
    if (node instanceof HTMLMediaElement) {
      handleMedia(node);
      return;
    }
    if (!(node instanceof Element)) return;

    for (const element of querySelectorAll.call(node, 'video, audio')) {
      if (element instanceof HTMLMediaElement) handleMedia(element);
    }
  }

  // ---------------------------------------------------------------------------
  // Layer 2: MutationObserver. Catches parser-inserted and SPA-injected media.
  // ---------------------------------------------------------------------------

  const observer = new MutationObserver((records) => {
    if (!blocking) return;

    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof HTMLMediaElement) handleMedia(record.target);
        continue;
      }
      for (const node of record.addedNodes) scanNode(node);
    }
  });

  // Observing `document` rather than `document.body` — at document_start there is no body
  // yet, and this also covers media inserted directly under <html>.
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['autoplay'],
  });

  // ---------------------------------------------------------------------------
  // Layer 3: capture-phase safety net. `play` does not bubble, but capture-phase
  // listeners on document still see it.
  // ---------------------------------------------------------------------------

  /**
   * @param {Event} event
   * @returns {void}
   */
  function onPlayEvent(event) {
    if (!blocking) return;

    const element = event.target;
    if (!(element instanceof HTMLMediaElement)) return;
    // A human pressing the element's native controls does not route through the patched
    // play(), so without this check we would instantly undo their click.
    if (hasUserActivation()) return;

    remember(element, true);
    countBlocked(element);
    stripAutoplay(element);
    nativePause.call(element);
  }

  document.addEventListener('play', onPlayEvent, true);

  // ---------------------------------------------------------------------------
  // Verdict handling
  // ---------------------------------------------------------------------------

  /**
   * Stand down and put back everything we touched.
   *
   * @returns {void}
   */
  function unblock() {
    blocking = false;
    mediaProto.play = nativePlay;
    observer.disconnect();
    document.removeEventListener('play', onPlayEvent, true);

    for (const [element, original] of originals) {
      if (original.preload === null) {
        removeAttribute.call(element, 'preload');
      } else {
        setAttribute.call(element, 'preload', original.preload);
      }

      if (original.autoplay) setAttribute.call(element, 'autoplay', '');

      // Re-adding the attribute does not restart an element that is already loaded, so
      // anything the page wanted playing has to be started explicitly.
      if (original.autoplay || original.wantedPlay) {
        // Swallow: the media may genuinely be unplayable, and that is the site's problem.
        nativePlay.call(element).catch(() => {});
      }
    }

    originals.clear();
    blockedCount = 0;
    reportCount();
  }

  /**
   * @param {boolean} shouldBlock
   * @returns {void}
   */
  function applyVerdict(shouldBlock) {
    if (settled) return;
    settled = true;

    if (shouldBlock) {
      // Nothing to undo, and the log would otherwise grow for the life of the page.
      originals.clear();
    } else {
      unblock();
    }

    // After `unblock`, so the held promises see the final state.
    const held = deferredPlays.splice(0, deferredPlays.length);
    for (const settlePlay of held) settlePlay();
  }

  /**
   * @param {MessageEvent} event
   * @returns {void}
   */
  function onMessage(event) {
    if (event.source !== window) return;

    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.channel !== VERDICT_CHANNEL) return;

    // First verdict wins. Page script can see this channel and could forge a message, but
    // it would have to beat our own document_start script to do so.
    applyVerdict(data.blocking === true);
  }

  window.addEventListener('message', onMessage);
  setTimeout(() => applyVerdict(true), VERDICT_TIMEOUT_MS);

  // ---------------------------------------------------------------------------
  // Count reporting (MAIN cannot reach chrome.*, so it goes out through ISOLATED)
  // ---------------------------------------------------------------------------

  /**
   * @returns {void}
   */
  function reportCount() {
    countReportTimer = null;
    window.postMessage({ channel: COUNT_CHANNEL, count: blockedCount }, '*');
  }

  /**
   * @returns {void}
   */
  function scheduleCountReport() {
    if (countReportTimer !== null) return;
    countReportTimer = setTimeout(reportCount, COUNT_REPORT_DELAY_MS);
  }
})();
