/**
 * LlamaVideoBlock options page — whitelist management.
 *
 * Renders straight from `chrome.storage.sync` and re-renders on `storage.onChanged`, so
 * the list stays correct when the popup adds a site, when another device syncs, or when
 * two copies of this page are open at once.
 */

(() => {
  'use strict';

  /**
   * @template {abstract new (...args: never) => unknown} T
   * @param {string} id
   * @param {T} type
   * @returns {InstanceType<T>}
   */
  function requireElement(id, type) {
    const element = document.getElementById(id);
    if (!(element instanceof type)) {
      throw new Error(`[LlamaVideoBlock] Options element #${id} is missing or the wrong type`);
    }
    return /** @type {InstanceType<T>} */ (element);
  }

  const ui = {
    form: requireElement('add-form', HTMLFormElement),
    input: requireElement('add-input', HTMLInputElement),
    error: requireElement('add-error', HTMLElement),
    list: requireElement('list', HTMLUListElement),
    listCount: requireElement('list-count', HTMLElement),
    empty: requireElement('empty', HTMLElement),
    clearRow: requireElement('clear-row', HTMLElement),
    clear: requireElement('clear', HTMLButtonElement),
    confirm: requireElement('confirm', HTMLElement),
    clearConfirm: requireElement('clear-confirm', HTMLButtonElement),
    clearCancel: requireElement('clear-cancel', HTMLButtonElement),
    live: requireElement('live', HTMLElement),
  };

  /** @type {string[]} */
  let whitelist = [];

  /**
   * @param {string} message
   * @returns {void}
   */
  function announce(message) {
    ui.live.textContent = message;
  }

  /**
   * @param {string | null} message null clears the error
   * @returns {void}
   */
  function showError(message) {
    ui.error.hidden = message === null;
    ui.error.textContent = message ?? '';
    if (message === null) {
      ui.input.removeAttribute('aria-invalid');
    } else {
      ui.input.setAttribute('aria-invalid', 'true');
    }
  }

  /**
   * @param {string} domain
   * @returns {HTMLLIElement}
   */
  function buildRow(domain) {
    const row = document.createElement('li');
    row.className = 'row';

    const label = document.createElement('span');
    label.className = 'row__domain';
    // textContent, not innerHTML — a whitelist entry is user input and must never be
    // parsed as markup.
    label.textContent = domain;

    const remove = document.createElement('button');
    remove.className = 'row__remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `Remove ${domain}`;
    remove.setAttribute('aria-label', `Remove ${domain} from the whitelist`);
    remove.addEventListener('click', () => void removeDomain(domain));

    row.append(label, remove);
    return row;
  }

  /**
   * @returns {void}
   */
  function render() {
    ui.list.replaceChildren(...whitelist.map(buildRow));
    ui.listCount.textContent = String(whitelist.length);
    ui.empty.hidden = whitelist.length > 0;
    ui.clearRow.hidden = whitelist.length === 0;
    hideConfirm();
  }

  /**
   * @returns {Promise<void>}
   */
  async function load() {
    whitelist = await LlamaVideoBlockStore.getWhitelist();
    render();
  }

  /**
   * @param {string} domain
   * @returns {Promise<void>}
   */
  async function removeDomain(domain) {
    try {
      whitelist = await LlamaVideoBlockStore.removeDomain(domain);
      render();
      announce(`${domain} removed`);
    } catch (error) {
      console.error('[LlamaVideoBlock] Failed to remove a whitelist entry:', error);
      showError('Could not save that change. Try again.');
    }
  }

  /**
   * @returns {void}
   */
  function hideConfirm() {
    ui.confirm.hidden = true;
    ui.clear.hidden = false;
  }

  ui.form.addEventListener('submit', (event) => {
    event.preventDefault();

    const raw = ui.input.value;
    const domain = LlamaVideoBlockDomain.normalize(raw);

    if (domain === null) {
      showError(`"${raw.trim()}" is not a domain LlamaVideoBlock can use.`);
      ui.input.focus();
      return;
    }

    const covering = whitelist.find((entry) => LlamaVideoBlockDomain.covers(entry, domain));
    if (covering !== undefined) {
      showError(
        covering === domain
          ? `${domain} is already whitelisted.`
          : `${domain} is already covered by ${covering}.`,
      );
      ui.input.focus();
      return;
    }

    void (async () => {
      try {
        whitelist = await LlamaVideoBlockStore.addDomain(domain);
        ui.input.value = '';
        showError(null);
        render();
        announce(`${domain} added`);
      } catch (error) {
        console.error('[LlamaVideoBlock] Failed to add a whitelist entry:', error);
        showError('Could not save that change. Try again.');
      }
    })();
  });

  ui.input.addEventListener('input', () => showError(null));

  ui.clear.addEventListener('click', () => {
    ui.clear.hidden = true;
    ui.confirm.hidden = false;
    ui.clearConfirm.focus();
  });

  ui.clearCancel.addEventListener('click', () => {
    hideConfirm();
    ui.clear.focus();
  });

  ui.clearConfirm.addEventListener('click', () => {
    void (async () => {
      try {
        await LlamaVideoBlockStore.clearWhitelist();
        whitelist = [];
        render();
        announce('Whitelist cleared');
      } catch (error) {
        console.error('[LlamaVideoBlock] Failed to clear the whitelist:', error);
        showError('Could not clear the whitelist. Try again.');
      }
    })();
  });

  // Keeps this page in step with the popup, other open copies, and sync from other devices.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !(LlamaVideoBlockStore.WHITELIST_KEY in changes)) return;
    void load();
  });

  void load();
})();
