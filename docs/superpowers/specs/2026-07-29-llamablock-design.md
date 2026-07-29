# LlamaBlock — Implementation Design

**Date:** 2026-07-29
**Status:** Approved by Rob (Head Llama), 2026-07-29
**Source spec:** [`LLAMABLOCK_SPEC.md`](../../../LLAMABLOCK_SPEC.md)

This document records the design decisions taken *on top of* `LLAMABLOCK_SPEC.md`, and the
reasoning behind each. The spec remains the product definition; this is the technical design
that implements it. Where the two disagree, this document wins and says why.

---

## 1. Injection strategy — the one material deviation from the spec

**Spec §6 says:** the background service worker checks the whitelist and only *then* injects the
content script.

**That cannot work.** Two independent reasons:

1. `chrome.scripting.executeScript` runs after the page has begun parsing and loading media.
   By the time the script lands, autoplay has already started.
2. Overriding `HTMLMediaElement.prototype.play` only works if it happens **before any page
   script runs**. A programmatically-injected script always loses that race — YouTube's player
   has already captured the original function.

**What we build instead:** two manifest-declared content scripts, both `run_at:
"document_start"`, `matches: ["<all_urls>"]`, `all_frames: true`.

| Script | World | Job |
| --- | --- | --- |
| `content-main.js` | `MAIN` | Runs before page scripts. Patches `play()`, strips `autoplay`, pauses media. **Starts blocking unconditionally.** |
| `content-isolated.js` | `ISOLATED` | Reads `chrome.storage`, computes the verdict, hands it to `content-main.js`. Also relays blocked counts to the background. |

The whitelist check moves *into the page* instead of gating injection.

### Fail-closed ordering

`content-main.js` blocks from its first instruction. The verdict arrives ~1ms later over
`window.postMessage`. If the verdict says "allowed", the blocker unpatches itself and **replays
everything it blocked during that window** — media it paused is resumed, `autoplay` attributes it
stripped are restored, `play()` calls it rejected are re-issued.

If the verdict never arrives (storage error, extension reloaded mid-navigation), the page stays
blocked. Blocking is the safe failure mode; the spec's default state is "blocked everywhere".

### Consequences we accept

- The extension runs on every page, including whitelisted ones. On a whitelisted page it
  unpatches within a frame and does nothing further. This departs from spec §2's "extension does
  nothing" — it does nothing *observable*, but it is present.
- The MAIN↔ISOLATED channel is `window.postMessage`, which page script can see and could forge.
  Mitigated by first-verdict-wins (later messages are ignored), so a page would have to beat our
  own `document_start` script to the punch. Worst case for a hostile site is that it autoplays —
  which is what it wanted anyway. Not worth further hardening in v1.
- **Whitelist changes take effect on next page load.** Toggling from the popup reloads the
  current tab so the change is immediately visible; this is deliberate and removes the need for
  live re-patching.

---

## 2. Three layers of blocking

No single hook catches everything, so we run three, each covering the others' gaps:

1. **`play()` override** (MAIN world, before page scripts) — catches JS-initiated autoplay,
   which is how YouTube, Facebook, and every modern player actually start media. This is the
   load-bearing layer.
2. **`autoplay` attribute stripping** (MutationObserver, `childList` + `subtree` +
   `attributeFilter: ['autoplay']`, observing `document`) — catches declarative
   `<video autoplay>` before it begins loading, and catches SPA-injected elements. Covers spec
   §6's "MutationObserver" requirement and the YouTube SPA case in §6 with no YouTube-specific
   code.
3. **Capture-phase `play` event listener on `document`** — the safety net. `play` does not
   bubble, but capture-phase listeners still see it, so this catches anything the first two
   layers miss, including media started through paths we did not patch.

We deliberately do **not** patch the `autoplay` property accessor on `HTMLMediaElement.prototype`.
Doing so makes reads and writes disagree with each other and breaks site logic that round-trips
the value, and layers 2 and 3 already cover the behaviour it would buy us.

### Rejecting like Chrome does

When we block a `play()` call we return a rejected promise carrying a `DOMException` named
`NotAllowedError` with Chrome's own message text. That is the exact error Chrome's built-in
autoplay policy throws, so every real player already has a handler for it. Sites show their play
button and stop, instead of breaking or entering a retry loop.

### User-gesture detection

`navigator.userActivation.isActive`. Accurate for real clicks, correctly false during page load.
Accepted limitation: transient activation lasts ~5s, so a site has a short window after any user
interaction in which it could slip an autoplay through. Rare in practice, and the alternative
(no gesture detection) would break every play button on the web.

Native video controls do not route through the JS-visible `play()`, so clicking a video's own
controls is unaffected by the override. The capture-phase listener checks user activation for the
same reason — without it, clicking native controls would be instantly undone.

---

## 3. First frame (spec §2)

A video that has never played renders its `poster`, or black if there is no poster. Showing
literal frame 1 requires a metadata load.

**Decision:** when we strip `autoplay`, we force `preload="metadata"` — but only if the element's
preload is unset or `none`. If the site already asked for `metadata` or `auto` we leave it alone,
and we never downgrade. This gets a real frame on most sites at metadata cost, and "first frame"
is treated as best-effort rather than guaranteed.

---

## 4. Permissions

```
"permissions":      ["storage", "tabs"]
"host_permissions": ["<all_urls>"]
```

`activeTab` and `scripting` from spec §6 are dropped — neither is used once injection is
declarative. `tabs` is needed to read the current tab's hostname for popup status and per-tab
badge state.

**Chrome Web Store justification for `<all_urls>`** (approved wording):

> Required to block autoplay on all sites, not just specific domains. The extension operates
> entirely client-side with no data transmission.

---

## 5. Storage

| Store | Key | Contents |
| --- | --- | --- |
| `chrome.storage.sync` | `whitelist` | `string[]` of domains. Syncs across devices per spec §4. |
| `chrome.storage.local` | `enabled` | `boolean` master toggle, defaults `true`. Per spec §6. |
| `chrome.storage.session` | `blockCounts` | `{ [tabId]: { [frameId]: number } }`. Cosmetic popup counter. |

`storage.session` is in-memory and survives service-worker restarts, which a plain module-scope
variable would not — the worker is evicted after ~30s idle and the counter would read zero every
time the popup opened.

### Domain matching

Shared logic in `shared/domain.js`, loaded by all four consumers with no build step: content
scripts list it first in their `js` array, the popup and options pages use `<script src>`, and the
background worker uses `importScripts()` (which is why the worker is a classic script, not a
module).

- **Normalisation:** accept a pasted URL or a bare domain, lowercase it, strip a leading `www.`.
  We do *not* reduce to eTLD+1 — that needs the Public Suffix List, and naive truncation would
  turn `bbc.co.uk` into `co.uk` and whitelist all of Britain.
- **Matching:** `hostname === domain || hostname.endsWith('.' + domain)`. Subdomain-inclusive, so
  `netflix.com` covers all Netflix pages per spec §2.
- Known v1 rough edge: whitelisting while on `m.youtube.com` stores `m.youtube.com`, which does
  not cover `www.youtube.com`. The options page lets the user correct it. Not worth a PSL
  dependency in v1.

---

## 6. Toolbar icon states (spec §5)

| State | Implementation |
| --- | --- |
| Blocking active | Full-colour icon |
| Master toggle off | Grayscale icon set via `chrome.action.setIcon` |
| Current site whitelisted | Green `✓` badge via `setBadgeText` / `setBadgeBackgroundColor` |

Refreshed on `tabs.onActivated`, `tabs.onUpdated`, and storage changes.

---

## 7. Language and tooling

Plain JavaScript with JSDoc types, checked by `tsc --noEmit` with `strict` + `checkJs`. Full type
safety, no bundler, no build step — the repo *is* the shipped extension. A bundler for six source
files would be over-engineering, and an unbundled extension is easier for Chrome Web Store review
to read.

Icons are generated by `tools/generate-icons.mjs`, a dependency-free PNG encoder built on Node's
`zlib`. Placeholder art only; the commissioned 3D cement block replaces it before submission.

---

## 8. Testing

Playwright drives a real Chrome with the unpacked extension loaded via
`--disable-extensions-except` + `--load-extension` in a persistent context.

- **Fixtures are local.** A dependency-free Node HTTP server serves the test pages. Tests never
  depend on YouTube or Facebook being reachable or unchanged.
- **Test media is a generated WAV.** Both `<audio>` and `<video>` elements accept it — a `<video>`
  playing an audio-only source still exercises the full `HTMLMediaElement` path, and WAV is the
  one media container that can be written from scratch in Node with no encoder dependency.
- **Chrome's own autoplay policy is disabled** in tests via
  `--autoplay-policy=no-user-gesture-required`. Without this we would be measuring Chrome's
  blocking, not ours. Every blocking test is paired with a control run (extension disabled via the
  master toggle) that proves the media *would* have autoplayed.

Cases covered: `<video autoplay>`, `<audio autoplay>`, JS-initiated `play()`, SPA-injected media,
user-click playback (must be **allowed**), whitelisted domain (must be **allowed**), master toggle
off (must be **allowed**), and the blocked-count reporting path.

Manual verification against real YouTube and Facebook sits on top of the automated suite; it is
not a substitute for it.

---

## 9. Out of scope, confirmed

Everything in spec §9, unchanged. Additionally out of scope for v1: live whitelist application
without a page reload, Public Suffix List domain reduction, and hardening the MAIN↔ISOLATED
channel against a page that specifically targets LlamaBlock.
