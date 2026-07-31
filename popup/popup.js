/**
 * LlamaAutoPlayBlock popup.
 *
 * Reads state straight from storage rather than messaging the service worker — the popup
 * is a trusted extension context, so it can see all three stores, and this keeps the
 * popup working even when the worker has been evicted.
 *
 * Both toggles reload the current tab. Whitelist changes only take effect on the next
 * page load by design (see the design doc), and a user who has just clicked "whitelist
 * this site" wants the video working now, not after a manual refresh.
 */

(() => {
  'use strict';

  /**
   * @typedef {object} PopupElements
   * @property {HTMLElement} panel
   * @property {HTMLInputElement} masterToggle
   * @property {HTMLElement} host
   * @property {HTMLElement} pill
   * @property {HTMLButtonElement} whitelistToggle
   * @property {HTMLElement} note
   * @property {HTMLElement} tally
   * @property {HTMLElement} tallyValue
   * @property {HTMLElement} tallyLabel
   * @property {HTMLButtonElement} manage
   * @property {HTMLElement} diag
   * @property {HTMLElement} diagLog
   * @property {HTMLButtonElement} diagCopy
   * @property {HTMLElement} live
   */

  /**
   * @template {abstract new (...args: never) => unknown} T
   * @param {string} id
   * @param {T} type
   * @returns {InstanceType<T>}
   */
  function requireElement(id, type) {
    const element = document.getElementById(id);
    if (!(element instanceof type)) {
      throw new Error(`[LlamaAutoPlayBlock] Popup element #${id} is missing or the wrong type`);
    }
    return /** @type {InstanceType<T>} */ (element);
  }

  /** @type {PopupElements} */
  const ui = {
    panel: requireElement('panel', HTMLElement),
    masterToggle: requireElement('master-toggle', HTMLInputElement),
    host: requireElement('site-host', HTMLElement),
    pill: requireElement('site-pill', HTMLElement),
    whitelistToggle: requireElement('whitelist-toggle', HTMLButtonElement),
    note: requireElement('site-note', HTMLElement),
    tally: requireElement('tally', HTMLElement),
    tallyValue: requireElement('tally-value', HTMLElement),
    tallyLabel: requireElement('tally-label', HTMLElement),
    manage: requireElement('manage', HTMLButtonElement),
    diag: requireElement('diag', HTMLElement),
    diagLog: requireElement('diag-log', HTMLElement),
    diagCopy: requireElement('diag-copy', HTMLButtonElement),
    live: requireElement('live', HTMLElement),
  };

  /**
   * @typedef {object} PopupState
   * @property {number | null} tabId
   * @property {string | null} hostname null on pages LlamaAutoPlayBlock cannot act on
   * @property {boolean} enabled
   * @property {string[]} whitelist
   * @property {number} blockedCount
   * @property {boolean} debug diagnostics enabled from the options page
   * @property {string[]} debugLines decisions recorded for this tab
   */

  /** @type {PopupState} */
  let state = {
    tabId: null,
    hostname: null,
    enabled: true,
    whitelist: [],
    blockedCount: 0,
    debug: false,
    debugLines: [],
  };

  /**
   * The whitelist entry that governs the current host. Usually the host itself, but if
   * the user whitelisted a parent domain we want the button to remove *that* entry rather
   * than silently adding a redundant one.
   *
   * @returns {string | null}
   */
  function matchingEntry() {
    const hostname = state.hostname;
    if (!hostname) return null;
    return state.whitelist.find((domain) => LlamaAutoPlayBlockDomain.covers(domain, hostname)) ?? null;
  }

  /**
   * @param {string} message
   * @returns {void}
   */
  function announce(message) {
    ui.live.textContent = message;
  }

  /**
   * @returns {void}
   */
  function render() {
    const entry = matchingEntry();
    const whitelisted = entry !== null;
    const actionable = state.hostname !== null;

    ui.panel.dataset.enabled = String(state.enabled);
    ui.masterToggle.checked = state.enabled;

    // textContent, never innerHTML — these lines contain page-supplied values such as
    // element ids and media URLs.
    ui.diag.hidden = !state.debug;
    ui.diagLog.textContent = state.debugLines.join('\n');

    ui.host.textContent = state.hostname ?? 'Not a web page';

    if (!actionable) {
      ui.pill.dataset.state = 'unknown';
      ui.pill.textContent = 'N/A';
      ui.whitelistToggle.hidden = true;
      ui.note.hidden = false;
      ui.note.textContent =
        'LlamaAutoPlayBlock only runs on http and https pages, so there is nothing to do here.';
      ui.tally.hidden = true;
      return;
    }

    ui.note.hidden = state.enabled;
    if (!state.enabled) {
      ui.note.textContent = 'Blocking is off everywhere. Autoplay works normally on all sites.';
    }

    if (!state.enabled) {
      ui.pill.dataset.state = 'off';
      ui.pill.textContent = 'Off';
    } else if (whitelisted) {
      ui.pill.dataset.state = 'allowed';
      ui.pill.textContent = 'Allowed';
    } else {
      ui.pill.dataset.state = 'blocked';
      ui.pill.textContent = 'Blocked';
    }

    ui.whitelistToggle.hidden = false;
    ui.whitelistToggle.disabled = !state.enabled;
    ui.whitelistToggle.textContent = whitelisted
      ? `Remove ${entry} from whitelist`
      : 'Whitelist this site';

    const showTally = state.enabled && !whitelisted && state.blockedCount > 0;
    ui.tally.hidden = !showTally;
    if (showTally) {
      ui.tallyValue.textContent = String(state.blockedCount);
      ui.tallyLabel.textContent =
        state.blockedCount === 1 ? 'autoplay blocked here' : 'autoplays blocked here';
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async function load() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const { enabled, whitelist, debug } = await LlamaAutoPlayBlockStore.getSettings();

      const tabId = tab?.id ?? null;
      const hostname = LlamaAutoPlayBlockDomain.fromUrl(tab?.url);
      const blockedCount = tabId === null ? 0 : await LlamaAutoPlayBlockStore.getTabCount(tabId);
      const debugLines =
        debug && tabId !== null ? await LlamaAutoPlayBlockStore.getDebugLines(tabId) : [];

      state = { tabId, hostname, enabled, whitelist, blockedCount, debug, debugLines };
      render();
    } catch (error) {
      console.error('[LlamaAutoPlayBlock] Failed to load popup state:', error);
      ui.host.textContent = 'Something went wrong';
      ui.pill.dataset.state = 'unknown';
      ui.pill.textContent = 'Error';
      ui.whitelistToggle.hidden = true;
      ui.tally.hidden = true;
    }
  }

  /**
   * Whitelist and toggle changes only bite on the next page load, so apply them by
   * reloading. Skipped for tabs LlamaAutoPlayBlock does not act on.
   *
   * @returns {Promise<void>}
   */
  async function reloadTab() {
    if (state.tabId === null || state.hostname === null) return;
    try {
      await chrome.tabs.reload(state.tabId);
    } catch (error) {
      console.error('[LlamaAutoPlayBlock] Failed to reload the current tab:', error);
    }
  }

  ui.masterToggle.addEventListener('change', () => {
    void (async () => {
      const enabled = ui.masterToggle.checked;
      try {
        await LlamaAutoPlayBlockStore.setEnabled(enabled);
        state = { ...state, enabled, blockedCount: 0 };
        render();
        announce(enabled ? 'Blocking on' : 'Blocking off');
        await reloadTab();
      } catch (error) {
        console.error('[LlamaAutoPlayBlock] Failed to change the master toggle:', error);
        // Put the switch back where it was rather than lying about the stored state.
        ui.masterToggle.checked = !enabled;
      }
    })();
  });

  ui.whitelistToggle.addEventListener('click', () => {
    void (async () => {
      const hostname = state.hostname;
      if (!hostname) return;

      const entry = matchingEntry();
      ui.whitelistToggle.disabled = true;

      try {
        const whitelist = entry
          ? await LlamaAutoPlayBlockStore.removeDomain(entry)
          : await LlamaAutoPlayBlockStore.addDomain(hostname);

        state = { ...state, whitelist, blockedCount: 0 };
        render();
        announce(entry ? `${entry} removed from whitelist` : `${hostname} whitelisted`);
        await reloadTab();
      } catch (error) {
        console.error('[LlamaAutoPlayBlock] Failed to update the whitelist:', error);
        ui.whitelistToggle.disabled = false;
      }
    })();
  });

  ui.diagCopy.addEventListener('click', () => {
    void (async () => {
      const report = [
        `LlamaAutoPlayBlock ${chrome.runtime.getManifest().version}`,
        `site: ${state.hostname ?? '(none)'} | enabled: ${state.enabled} | ` +
          `whitelisted: ${matchingEntry() !== null} | blocked: ${state.blockedCount}`,
        `ua: ${navigator.userAgent}`,
        '',
        ...state.debugLines,
      ].join('\n');

      try {
        await navigator.clipboard.writeText(report);
        ui.diagCopy.textContent = 'Copied';
        announce('Diagnostics copied to the clipboard');
        setTimeout(() => {
          ui.diagCopy.textContent = 'Copy';
        }, 1500);
      } catch (error) {
        console.error('[LlamaAutoPlayBlock] Could not copy diagnostics:', error);
        ui.diagCopy.textContent = 'Failed';
      }
    })();
  });

  ui.manage.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  void load();
})();
