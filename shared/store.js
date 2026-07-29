/**
 * Storage access for LlamaVideoBlock. Classic script, loaded the same four ways as
 * `shared/domain.js`.
 *
 * Split across three stores on purpose:
 *   sync    — the whitelist, so it follows the user across devices (spec §6)
 *   local   — the master toggle, which is per-machine
 *   session — the per-tab blocked counter, which is cosmetic and should not persist
 *
 * Every read falls back to the blocking defaults (enabled, empty whitelist) if storage
 * throws. Storage does throw in practice: reloading the extension invalidates the context
 * of content scripts still running in open tabs. Failing closed there means a page keeps
 * blocking rather than silently letting autoplay through.
 */

const LlamaVideoBlockStore = {
  WHITELIST_KEY: 'whitelist',
  ENABLED_KEY: 'enabled',
  COUNTS_KEY: 'blockCounts',
  DEBUG_KEY: 'debug',

  /**
   * @returns {Promise<string[]>}
   */
  async getWhitelist() {
    try {
      const stored = await chrome.storage.sync.get(this.WHITELIST_KEY);
      const list = stored[this.WHITELIST_KEY];
      if (!Array.isArray(list)) return [];
      return list.filter((entry) => typeof entry === 'string' && entry.length > 0);
    } catch (error) {
      console.error('[LlamaVideoBlock] Failed to read whitelist:', error);
      return [];
    }
  },

  /**
   * @param {readonly string[]} whitelist
   * @returns {Promise<void>}
   */
  async setWhitelist(whitelist) {
    // Stored sorted and de-duplicated so the options page never has to sort for display
    // and `chrome.storage.onChanged` doesn't fire on no-op reorderings.
    const unique = [...new Set(whitelist)].sort();
    await chrome.storage.sync.set({ [this.WHITELIST_KEY]: unique });
  },

  /**
   * @returns {Promise<boolean>} defaults true — blocking is the installed default (spec §2)
   */
  async isEnabled() {
    try {
      const stored = await chrome.storage.local.get(this.ENABLED_KEY);
      const enabled = stored[this.ENABLED_KEY];
      return typeof enabled === 'boolean' ? enabled : true;
    } catch (error) {
      console.error('[LlamaVideoBlock] Failed to read master toggle:', error);
      return true;
    }
  },

  /**
   * @param {boolean} enabled
   * @returns {Promise<void>}
   */
  async setEnabled(enabled) {
    await chrome.storage.local.set({ [this.ENABLED_KEY]: enabled });
  },

  /**
   * Diagnostic logging. Off by default; turned on from the options page when a site is
   * misbehaving and we need to see which layer fired and why.
   *
   * @returns {Promise<boolean>}
   */
  async isDebug() {
    try {
      const stored = await chrome.storage.local.get(this.DEBUG_KEY);
      return stored[this.DEBUG_KEY] === true;
    } catch (error) {
      console.error('[LlamaVideoBlock] Failed to read the debug flag:', error);
      return false;
    }
  },

  /**
   * @param {boolean} debug
   * @returns {Promise<void>}
   */
  async setDebug(debug) {
    await chrome.storage.local.set({ [this.DEBUG_KEY]: debug });
  },

  /**
   * Everything the content script needs, in one hop. This is the hot path — it runs on
   * every frame of every page load, and the reads go out in parallel.
   *
   * @returns {Promise<{ enabled: boolean, whitelist: string[], debug: boolean }>}
   */
  async getSettings() {
    const [enabled, whitelist, debug] = await Promise.all([
      this.isEnabled(),
      this.getWhitelist(),
      this.isDebug(),
    ]);
    return { enabled, whitelist, debug };
  },

  /**
   * @param {string} domain already normalised
   * @returns {Promise<string[]>} the updated whitelist
   */
  async addDomain(domain) {
    const whitelist = await this.getWhitelist();
    if (!whitelist.includes(domain)) whitelist.push(domain);
    await this.setWhitelist(whitelist);
    return [...new Set(whitelist)].sort();
  },

  /**
   * @param {string} domain
   * @returns {Promise<string[]>} the updated whitelist
   */
  async removeDomain(domain) {
    const whitelist = (await this.getWhitelist()).filter((entry) => entry !== domain);
    await this.setWhitelist(whitelist);
    return whitelist;
  },

  /**
   * @returns {Promise<void>}
   */
  async clearWhitelist() {
    await this.setWhitelist([]);
  },

  /**
   * Blocked-play counts, keyed by tab and then by frame so counts from embedded players
   * add up instead of overwriting each other.
   *
   * @returns {Promise<Record<string, Record<string, number>>>}
   */
  async getAllCounts() {
    try {
      const stored = await chrome.storage.session.get(this.COUNTS_KEY);
      const counts = stored[this.COUNTS_KEY];
      if (!counts || typeof counts !== 'object') return {};
      return /** @type {Record<string, Record<string, number>>} */ (counts);
    } catch (error) {
      console.error('[LlamaVideoBlock] Failed to read blocked counts:', error);
      return {};
    }
  },

  /**
   * @param {number} tabId
   * @returns {Promise<number>} total blocked plays across every frame of the tab
   */
  async getTabCount(tabId) {
    const frames = (await this.getAllCounts())[String(tabId)];
    if (!frames) return 0;
    return Object.values(frames).reduce((total, n) => total + n, 0);
  },

  /**
   * Records a frame's running total. The content script sends totals rather than deltas,
   * so a dropped message costs accuracy only until the next report.
   *
   * @param {number} tabId
   * @param {number} frameId
   * @param {number} count
   * @returns {Promise<void>}
   */
  async setFrameCount(tabId, frameId, count) {
    const counts = await this.getAllCounts();
    const frames = counts[String(tabId)] ?? {};
    frames[String(frameId)] = count;
    counts[String(tabId)] = frames;
    await chrome.storage.session.set({ [this.COUNTS_KEY]: counts });
  },

  /**
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async clearTabCount(tabId) {
    const counts = await this.getAllCounts();
    if (!(String(tabId) in counts)) return;
    delete counts[String(tabId)];
    await chrome.storage.session.set({ [this.COUNTS_KEY]: counts });
  },
};
