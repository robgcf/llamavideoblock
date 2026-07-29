/**
 * LlamaVideoBlock — MAIN-world autoplay blocker.
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
 * @see docs/superpowers/specs/2026-07-29-llamavideoblock-design.md
 */

(() => {
  'use strict';

  const VERDICT_CHANNEL = 'llamavideoblock:verdict';
  const COUNT_CHANNEL = 'llamavideoblock:count';
  const DEBUG_CHANNEL = 'llamavideoblock:debug';

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

  // ---------------------------------------------------------------------------
  // Diagnostics
  //
  // Off by default. The interesting decisions all happen before the verdict arrives,
  // which is also before we know whether logging is wanted — so every decision is
  // recorded to a bounded buffer regardless, and the buffer is dumped if the verdict
  // says debug is on. Costs a string per decision on a normal page load.
  // ---------------------------------------------------------------------------

  let debug = false;
  /** @type {string[]} */
  const debugBuffer = [];
  const MAX_DEBUG_LINES = 300;

  /**
   * @param {HTMLMediaElement} element
   * @returns {string}
   */
  function describe(element) {
    const source = element.currentSrc || element.src || '(no src)';
    const id = element.id ? `#${element.id}` : '';
    const cls = element.className ? `.${String(element.className).split(/\s+/)[0]}` : '';
    return `${element.tagName.toLowerCase()}${id}${cls} src=${source.slice(0, 60)} ` +
      `readyState=${element.readyState} paused=${element.paused}`;
  }

  /**
   * @param {string} message
   * @param {string} [detail]
   * @returns {void}
   */
  function trace(message, detail) {
    const line =
      `+${Math.round(performance.now())}ms [${window === window.top ? 'top' : 'frame'}] ` +
      `${message}${detail ? ` — ${detail}` : ''}`;

    if (debug) {
      console.log('%c[LlamaVideoBlock]', 'color:#eda13c;font-weight:bold', line);
      queueForPopup(line);
      return;
    }
    if (debugBuffer.length < MAX_DEBUG_LINES) debugBuffer.push(line);
  }

  /**
   * Decisions also go to the popup, so diagnosing does not require opening DevTools on a
   * page that may be drowning in other extensions' logging.
   *
   * @type {string[]}
   */
  const popupQueue = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let popupFlushTimer = null;

  /**
   * @param {string} line
   * @returns {void}
   */
  function queueForPopup(line) {
    popupQueue.push(line);
    if (popupFlushTimer !== null) return;
    popupFlushTimer = setTimeout(() => {
      popupFlushTimer = null;
      const lines = popupQueue.splice(0, popupQueue.length);
      window.postMessage({ channel: DEBUG_CHANNEL, lines }, '*');
    }, 400);
  }

  /**
   * Who called `play()`. The immediate frames are ours, so they are dropped.
   *
   * @returns {string}
   */
  function callerFrames() {
    const stack = new Error().stack ?? '';
    return stack.split('\n').slice(2, 5).map((frame) => frame.trim()).join(' <- ');
  }

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
    const activation = hasUserActivation();
    trace(
      `play() called — blocking=${blocking} userActivation=${activation} settled=${settled}`,
      `${describe(this)} | from: ${callerFrames()}`,
    );

    if (!blocking) {
      trace('play() ALLOWED — not blocking on this page');
      return nativePlay.call(this);
    }
    if (activation) {
      trace('play() ALLOWED — transient user activation was live');
      return nativePlay.call(this);
    }

    // `wantedPlay` stays false: if the verdict turns out to be "allowed", this element is
    // started by its own deferred promise below rather than by the bulk restore.
    remember(this, false);
    countBlocked(this);
    stripAutoplay(this);

    if (settled || deferredPlays.length >= MAX_TRACKED_ELEMENTS) {
      trace('play() BLOCKED — rejected with NotAllowedError');
      return Promise.reject(notAllowedError());
    }

    trace('play() HELD — waiting for the whitelist verdict before settling this promise');

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
   * Snapshot an element's pre-LlamaVideoBlock state. No-op once the verdict has settled —
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
      trace('autoplay attribute STRIPPED', describe(element));
      remember(element, false);
      countBlocked(element);
      stripAutoplay(element);
    }

    // Media may already have started between insertion and this callback.
    if (!element.paused && !hasUserActivation()) {
      trace('already playing on discovery — PAUSED', describe(element));
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
    if (!(element instanceof HTMLMediaElement)) {
      trace(`play event from a NON-media target — ${String(event.target)}`);
      return;
    }
    // A human pressing the element's native controls does not route through the patched
    // play(), so without this check we would instantly undo their click.
    if (hasUserActivation()) {
      trace('play event ALLOWED — transient user activation was live', describe(element));
      return;
    }

    trace('play event caught by the safety net — PAUSING', describe(element));
    remember(element, true);
    countBlocked(element);
    stripAutoplay(element);
    nativePause.call(element);
  }

  document.addEventListener('play', onPlayEvent, true);

  // Diagnostics only: tells us playback actually started, which is the thing we are trying
  // to explain when a site wins anyway. Never intervenes.
  document.addEventListener(
    'playing',
    (event) => {
      if (event.target instanceof HTMLMediaElement) {
        trace(
          `MEDIA IS PLAYING — blocking=${blocking} userActivation=${hasUserActivation()}`,
          describe(event.target),
        );
      }
    },
    true,
  );

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

    // Flush what happened before we knew logging was wanted, then carry on live.
    if (debug && debugBuffer.length > 0) {
      console.groupCollapsed(
        `%c[LlamaVideoBlock] ${debugBuffer.length} decisions before the verdict`,
        'color:#eda13c;font-weight:bold',
      );
      for (const line of debugBuffer) console.log(line);
      console.groupEnd();
      for (const line of debugBuffer) queueForPopup(line);
    }
    debugBuffer.length = 0;
    trace(`verdict received — blocking=${shouldBlock}`);

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

    // Set before applying, so the buffered decisions get flushed.
    debug = data.debug === true;

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
