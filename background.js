/**
 * LlamaVideoBlock — background service worker.
 *
 * Deliberately not on the blocking path. Content scripts are declared in the manifest and
 * read storage themselves, so autoplay blocking works whether or not this worker is
 * running. Everything here is presentation and bookkeeping:
 *
 *   - toolbar icon and badge state (spec §5)
 *   - per-tab blocked counts for the popup
 *
 * A classic worker rather than a module, so `importScripts` can pull in the same shared
 * scripts the content scripts and pages use.
 *
 * @see docs/superpowers/specs/2026-07-29-llamavideoblock-design.md
 */

importScripts('shared/domain.js', 'shared/store.js');

const COLOUR_ICONS = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

const GRAY_ICONS = {
  16: 'icons/icon16-gray.png',
  32: 'icons/icon32-gray.png',
  48: 'icons/icon48-gray.png',
  128: 'icons/icon128-gray.png',
};

const BADGE_WHITELISTED = '✓';
const BADGE_COLOUR = '#22C55E';

// ---------------------------------------------------------------------------
// Toolbar presentation
// ---------------------------------------------------------------------------

/**
 * Colour when blocking, grayscale when the master toggle is off. Global rather than
 * per-tab, because the master toggle is global.
 *
 * @returns {Promise<void>}
 */
async function refreshIcon() {
  try {
    const enabled = await LlamaVideoBlockStore.isEnabled();
    await chrome.action.setIcon({ path: enabled ? COLOUR_ICONS : GRAY_ICONS });
  } catch (error) {
    console.error('[LlamaVideoBlock] Failed to refresh toolbar icon:', error);
  }
}

/**
 * Green tick on tabs whose domain is whitelisted. Suppressed while the master toggle is
 * off, where the grayscale icon already says nothing is being blocked.
 *
 * @param {number} tabId
 * @param {string | undefined} url
 * @returns {Promise<void>}
 */
async function refreshBadge(tabId, url) {
  try {
    const { enabled, whitelist } = await LlamaVideoBlockStore.getSettings();
    const hostname = LlamaVideoBlockDomain.fromUrl(url);
    const whitelisted = enabled && LlamaVideoBlockDomain.isWhitelisted(whitelist, hostname);

    await chrome.action.setBadgeText({ tabId, text: whitelisted ? BADGE_WHITELISTED : '' });
    if (whitelisted) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOUR });
    }
  } catch (error) {
    // Routinely throws when a tab closes mid-refresh. Not worth surfacing.
    if (!isMissingTabError(error)) {
      console.error('[LlamaVideoBlock] Failed to refresh badge:', error);
    }
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingTabError(error) {
  return error instanceof Error && /No tab with id|Invalid tab ID/i.test(error.message);
}

/**
 * @returns {Promise<void>}
 */
async function refreshAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) => (tab.id === undefined ? undefined : refreshBadge(tab.id, tab.url))),
    );
  } catch (error) {
    console.error('[LlamaVideoBlock] Failed to refresh tabs:', error);
  }
}

/**
 * @returns {Promise<void>}
 */
async function refreshEverything() {
  await refreshIcon();
  await refreshAllTabs();
}

// ---------------------------------------------------------------------------
// Blocked counts
// ---------------------------------------------------------------------------

/**
 * Count writes are read-modify-write against session storage, and every frame of a page
 * reports independently. Serialising them stops concurrent frames from clobbering each
 * other's totals.
 *
 * @type {Promise<void>}
 */
let countWrites = Promise.resolve();

/**
 * @param {() => Promise<void>} write
 * @returns {void}
 */
function queueCountWrite(write) {
  countWrites = countWrites
    .then(write)
    .catch((error) => console.error('[LlamaVideoBlock] Failed to record blocked count:', error));
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== 'object' || message.type !== 'blockedCount') return false;

  const tabId = sender.tab?.id;
  const count = Number(message.count);
  if (tabId === undefined || !Number.isFinite(count)) return false;

  const frameId = sender.frameId ?? 0;
  queueCountWrite(() => LlamaVideoBlockStore.setFrameCount(tabId, frameId, count));
  return false;
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void (async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      await refreshBadge(tabId, tab.url);
    } catch (error) {
      if (!isMissingTabError(error)) {
        console.error('[LlamaVideoBlock] Failed to handle tab activation:', error);
      }
    }
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // A fresh document means the previous page's blocked count is stale.
  if (changeInfo.status === 'loading') {
    queueCountWrite(() => LlamaVideoBlockStore.clearTabCount(tabId));
  }
  if (changeInfo.status || changeInfo.url) {
    void refreshBadge(tabId, tab.url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  queueCountWrite(() => LlamaVideoBlockStore.clearTabCount(tabId));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  const affectsBlocking =
    (areaName === 'sync' && LlamaVideoBlockStore.WHITELIST_KEY in changes) ||
    (areaName === 'local' && LlamaVideoBlockStore.ENABLED_KEY in changes);

  if (affectsBlocking) void refreshEverything();
});

chrome.runtime.onInstalled.addListener(() => void refreshEverything());
chrome.runtime.onStartup.addListener(() => void refreshEverything());

// The worker is also woken by events after being evicted; make sure presentation is
// correct whenever it comes back up.
void refreshEverything();
