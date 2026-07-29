# LlamaVideoBlock

Chrome extension that blocks video and audio autoplay on every site, with a per-site
whitelist. Site-agnostic — no per-platform special cases.

**Axys Software LLC / LlamaCo.** Manifest V3. No build step, no runtime dependencies, no
data collection.

---

## Install for development

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select this directory

The repository *is* the extension. There is nothing to compile.

## Commands

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over the JSDoc-typed sources. Must be clean. |
| `npm test` | Playwright suite — drives a real Chrome with the extension loaded. |
| `npm run test:headed` | Same, with a visible browser. |
| `npm run check` | Typecheck then tests. The gate before any commit. |
| `npm run icons` | Regenerate the placeholder icons. |
| `npm run package` | Build `dist/llamavideoblock-<version>.zip` for the Chrome Web Store. |

## How the blocking works

Two content scripts run at `document_start` on every page.

`content-main.js` runs in the page's own JavaScript world, which means it executes before
any page script — the only point at which `HTMLMediaElement.prototype.play` can be
overridden before a player like YouTube's captures the original. It **starts blocking
unconditionally**.

`content-isolated.js` reads the whitelist and master toggle, then posts a verdict back.
If the answer is "allowed", the blocker unpatches itself and replays everything it
suppressed in that millisecond-wide window. If the verdict never arrives, the page stays
blocked — blocking is the safe failure mode.

Three layers do the actual blocking: the `play()` override, `autoplay` attribute stripping
via a `MutationObserver`, and a capture-phase `play` listener as a safety net. Blocked
`play()` calls are rejected with a `NotAllowedError` — the exact error Chrome's own
autoplay policy throws — so sites fall back to a play button instead of breaking.

Full reasoning, including what was deliberately not done:
[`docs/superpowers/specs/2026-07-29-llamavideoblock-design.md`](docs/superpowers/specs/2026-07-29-llamavideoblock-design.md).

## Layout

```
manifest.json
background.js            toolbar icon + badge state, per-tab blocked counts
content-main.js          MAIN world — the blocker
content-isolated.js      ISOLATED world — whitelist verdict, count relay
shared/domain.js         domain normalisation and whitelist matching
shared/store.js          storage access (sync / local / session)
shared/theme.css         design tokens for both pages
popup/                   toolbar popup
options/                 whitelist management
icons/                   placeholder art (colour + grayscale)
tools/                   icon generator, Web Store packager
tests/                   Playwright suite and local fixture server
```

## Testing notes

Tests never touch the live internet. `tests/fixtures/server.mjs` serves the fixture pages
and generates its own test media, so the suite cannot break because YouTube changed.

Chrome's *own* autoplay policy is disabled in the test browser
(`--autoplay-policy=no-user-gesture-required`). Without that, every "media did not play"
assertion would pass whether or not LlamaVideoBlock did anything. `tests/control.spec.js` is the
control group: it proves the same fixtures do autoplay when LlamaVideoBlock stands down.

## Before Chrome Web Store submission

- [ ] Replace the placeholder icons with the commissioned 3D cement block art
- [ ] **Publish the privacy policy.** The URL is settled and already linked from the options
      page: `https://llamahub.net/legal/llamavideoblock-privacy`. As of 2026-07-29 that route
      **404s** — it renders LlamaHub's not-found component, byte-identical to a nonexistent
      URL. Note the trap: the server answers **HTTP 200** and the 404 is drawn client-side,
      so a scripted link check passes while a human reviewer sees "Page not found". Verify by
      opening it in a browser, not with `curl`.
- [ ] Paste that URL into the Chrome Web Store dashboard under **Privacy practices → Privacy
      policy URL**. Google links out to it; nothing is copied into the extension.
- [ ] Bump `version` in `manifest.json` and `package.json`
- [ ] `npm run check`, then `npm run package`

**`<all_urls>` justification** (Chrome Web Store review will ask):

> Required to block autoplay on all sites, not just specific domains. The extension
> operates entirely client-side with no data transmission.

## Privacy

No analytics, no telemetry, no network requests of any kind. The whitelist lives in
`chrome.storage.sync` (so it follows a signed-in Chrome profile) and the master toggle in
`chrome.storage.local`. Nothing leaves the browser.
