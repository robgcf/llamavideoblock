/**
 * Domain normalisation and whitelist matching.
 *
 * Loaded as a classic script by all four consumers — content scripts (first entry in the
 * manifest `js` array), the popup and options pages (`<script src>`), and the background
 * worker (`importScripts`) — so there is exactly one copy of this logic and no build step.
 *
 * Pure: no chrome APIs, no DOM. Everything here is directly unit-testable.
 */

/** Matches a URL scheme prefix, e.g. `https://`, `chrome-extension://`. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Dot-separated hostname labels, post-punycode.
 *
 * `new URL` is more forgiving than it looks — it percent-encodes its way out of trouble,
 * so `http://not a domain` parses happily with the hostname `not%20a%20domain`. This is
 * what actually rejects junk input. Bracketed IPv6 literals are not accepted; they are
 * not a realistic whitelist entry and subdomain matching is meaningless for them.
 */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const LlamaAutoPlayBlockDomain = {
  /**
   * Strip a leading `www.` label. Everything else is left alone — we deliberately do not
   * reduce to a registrable domain, because that needs the Public Suffix List and naive
   * truncation turns `bbc.co.uk` into `co.uk`.
   *
   * @param {string} hostname
   * @returns {string}
   */
  stripWww(hostname) {
    return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
  },

  /**
   * The whitelist-comparable hostname for a page URL.
   *
   * @param {string | undefined | null} url
   * @returns {string | null} null for anything that isn't http(s) — extension pages,
   *   `about:blank`, `file://`, the Chrome Web Store, and so on.
   */
  fromUrl(url) {
    if (!url) return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return this.stripWww(parsed.hostname.toLowerCase()) || null;
  },

  /**
   * Normalise free-form user input into a storable domain. Accepts a bare domain, a
   * domain with a path, or a full URL. `new URL` does the heavy lifting: it lowercases,
   * punycodes IDNs, validates the host, and drops ports and paths for us.
   *
   * @param {string} input
   * @returns {string | null} null if the input cannot be read as a web domain
   */
  normalize(input) {
    const trimmed = String(input ?? '').trim();
    if (!trimmed) return null;

    const withScheme = SCHEME_RE.test(trimmed) ? trimmed : `http://${trimmed}`;
    let parsed;
    try {
      parsed = new URL(withScheme);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    const host = this.stripWww(parsed.hostname.toLowerCase());
    return HOSTNAME_RE.test(host) ? host : null;
  },

  /**
   * Does a whitelist entry cover a hostname? Subdomain-inclusive, so `netflix.com`
   * covers all Netflix pages as spec §2 requires.
   *
   * @param {string} domain whitelist entry, already normalised
   * @param {string} hostname page hostname, already `www.`-stripped
   * @returns {boolean}
   */
  covers(domain, hostname) {
    if (!domain || !hostname) return false;
    return hostname === domain || hostname.endsWith(`.${domain}`);
  },

  /**
   * @param {readonly string[]} whitelist
   * @param {string | null} hostname
   * @returns {boolean}
   */
  isWhitelisted(whitelist, hostname) {
    if (!hostname) return false;
    return whitelist.some((domain) => this.covers(domain, hostname));
  },
};
