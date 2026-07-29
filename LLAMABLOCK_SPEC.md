# LlamaBlock — Chrome Extension Spec
**Autoplay Blocker for Video and Audio | LlamaHub / Axys Software LLC**

---

## 1. Overview

LlamaBlock is a Chrome extension that blocks autoplay of video and audio across all websites by default, with a user-managed whitelist for sites where autoplay is permitted. It is designed to be simple, effective, and site-agnostic — unlike existing solutions that only target YouTube or specific platforms.

Target release: Chrome Web Store (public)

---

## 2. Core Behavior

**Default state (installed, no configuration):** autoplay blocked on all sites.

**When autoplay is blocked:**
- Video elements on the page load paused, showing the first frame
- Video remains visible and in-place — not hidden, collapsed, or removed
- User can click the video to play it manually as normal
- Audio-only autoplay is also blocked (audio elements with autoplay attribute)

**When a site is whitelisted:**
- Autoplay behaves normally on that domain — extension does nothing
- Whitelist applies to the full domain (e.g. `netflix.com` covers all Netflix pages)

---

## 3. What Gets Blocked

- HTML5 `<video>` elements with `autoplay` attribute — attribute removed and element paused on load
- HTML5 `<audio>` elements with `autoplay` attribute — same treatment
- JavaScript-initiated autoplay (`.play()` calls fired before user interaction) — intercepted via content script
- YouTube-specific: block autoplay on initial page load when navigating to a video tab. Does **not** block playlist autoplay or the "up next" autoplay between videos — user controls those via YouTube's own settings.
- Facebook, news sites, and all other video embeds — treated identically, no site-specific logic needed beyond the whitelist

**Does NOT block:**
- Videos the user explicitly clicks to play
- Autoplay on whitelisted domains
- YouTube playlist/queue autoplay (out of scope v1)

---

## 4. Whitelist

- User-managed list of domains where autoplay is permitted
- Domain-level matching only (e.g. `netflix.com` — no subdomain or path granularity needed in v1)
- Whitelist persists via `chrome.storage.sync` so it follows the user across devices if signed into Chrome
- Default whitelist: empty (blocked everywhere)

---

## 5. UI

### Toolbar Popup
Clicking the LlamaBlock icon in the Chrome toolbar opens a small popup with:

- **On/Off toggle** — master switch. When OFF, extension is fully disabled and autoplay works normally everywhere. Toggle state persists.
- **Current site status** — shows whether the current domain is whitelisted or blocked, with a one-click button to toggle whitelist status for the current site ("Whitelist this site" / "Remove from whitelist")
- **"Manage Whitelist" link** — opens the Options page (see below)
- LlamaBlock logo/name in the header

### Options Page
Full whitelist management:
- List of all whitelisted domains with remove (X) button per entry
- Text input + Add button to manually add a domain
- Clear all button (with confirmation)
- Simple, clean layout — no complexity needed

### Toolbar Icon States
- **Normal (blocking active):** full color LlamaBlock icon
- **Disabled (master toggle off):** grayscale icon
- **Current site whitelisted:** icon with a small green checkmark badge

---

## 6. Technical Approach

### Manifest Version
Manifest V3 (required for Chrome Web Store submissions as of 2024)

### Permissions Required
- `activeTab` — to interact with the current tab
- `storage` — for whitelist and toggle state persistence
- `scripting` — to inject content scripts
- `tabs` — to detect current tab URL for whitelist checking

### Content Script Strategy
Injected on every page load (except whitelisted domains):

1. **On DOM ready:** find all `<video>` and `<audio>` elements, remove `autoplay` attribute, call `.pause()` on any already playing
2. **MutationObserver:** watch for dynamically injected video/audio elements (common on SPAs like YouTube, Facebook) and apply the same treatment immediately on insertion
3. **Override `HTMLMediaElement.prototype.play`:** intercept JavaScript-initiated `.play()` calls and block them unless triggered by a direct user gesture. This catches sites that add autoplay via JS rather than the HTML attribute.

### YouTube-Specific Handling
YouTube is a SPA — navigating between videos doesn't reload the page. Use the MutationObserver approach to detect when a new video element appears after navigation and pause it immediately. No special YouTube-only code needed beyond ensuring the observer handles dynamic element insertion correctly.

### Whitelist Check
Before injecting the content script, background service worker checks the current tab's hostname against the whitelist. If whitelisted, content script is not injected.

### Storage
- `chrome.storage.sync` for whitelist (syncs across devices)
- `chrome.storage.local` for master toggle state

---

## 7. File Structure

```
llamablock/
├── manifest.json
├── background.js          (service worker — whitelist check, message handling)
├── content.js             (injected into pages — autoplay blocking logic)
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── options/
│   ├── options.html
│   ├── options.js
│   └── options.css
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png        (3D cement block with platform logos — to be designed)
```

---

## 8. Chrome Web Store Release

- Extension name: **LlamaBlock**
- Short description: "Blocks video and audio autoplay on all sites. Simple on/off toggle with per-site whitelist."
- Category: Productivity
- Privacy policy required (can be a simple page on llamahub.net)
- No user data collected beyond locally-stored whitelist preferences
- Pricing: Free

---

## 9. Out of Scope (v1)

- Firefox or other browser support
- Subdomain or path-level whitelist granularity
- YouTube playlist / up-next autoplay blocking
- Per-site autoplay rules beyond simple allow/block
- Keyboard shortcuts
- Sync with LlamaHub account (future potential)
- Usage statistics or analytics

---

## 10. Open Questions for Build

- Icon design: commission 3D cement block graphic with YouTube, Facebook, and other platform logos on faces before Chrome Store submission (not needed for functional build)
- Privacy policy page location on llamahub.net
- Whether to include a brief "what was blocked" count in the popup (e.g. "3 autoplays blocked on this page") — nice to have, not required
