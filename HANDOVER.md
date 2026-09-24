# Developer & AI Handover Guide (Linkwarden Speed Dial)

This document provides complete architectural and operational context for any developer or AI assistant continuing work on this codebase across different sessions or accounts.

---

## 1. Project Overview

**Linkwarden Speed Dial** is a lightweight, responsive, and customizable Firefox new tab extension (Manifest V3) that integrates with a self-hosted or cloud [Linkwarden](https://linkwarden.app) instance.

- **Target Browser**: Firefox (Manifest V3 compatible)
- **Primary Stack**: Vanilla JS (ES6+), HTML5, CSS3 with CSS Custom Properties
- **Theme**: Catppuccin Macchiato/Mocha dark styling
- **Repository**: `https://github.com/opaleiei/linkwardendial.git` (branch `main`)

---

## 2. File Structure & Responsibilities

| File | Role / Contents |
|---|---|
| `manifest.json` | WebExtension manifest (V3) specifying permissions (`storage`, `tabs`, `<all_urls>`), `chrome_url_overrides.newtab`, options UI. |
| `newtab.html` | Speed dial new tab view: grid container, floating action controls (+ Add Bookmark and ⚙ Settings), Add Bookmark modal, Edit Bookmark modal, custom Right-Click Context Menu, and sync toast status. |
| `newtab.css` | Complete stylesheet: Catppuccin theme, CSS variable-driven dial sizing (`small`, `medium`, `large`), column caps (3–10 or unlimited), drag & drop indicators, context menu, modals, with zero laggy transitions for potato PCs. |
| `newtab.js` | Core new tab logic: instant cache painting, event delegation on `#grid`, custom right-click context menu (new tab, background tab, new window, private window, edit, delete), drag-and-drop reordering, direct Linkwarden bookmark creation, updating & deletion, bidirectional cloud config sync. |
| `options.html` | Options page UI: credentials & connection tester, dial size selector, max columns selector, background color picker + hex input, wallpaper URL / file upload, collection filter, default sort, and order reset. |
| `options.js` | Options logic: loads and saves settings to `browser.storage.sync` and `browser.storage.local`, validates Linkwarden credentials via `/api/v1/collections`. |
| `docker-compose.yml` | Docker compose manifest to run Mini-Linkwarden standalone bookmark server on port 3000. |
| `server/` | Lightweight Linkwarden-compatible bookmark backend (Node.js, Dockerfile, atomic `db.json` storage). |
| `.gitignore` | Excludes `*.zip`, `.DS_Store`, `Thumbs.db`, and `data/`. |
| `README.md` | User-facing documentation and setup guide. |
| `HANDOVER.md` | This continuation document. |

---

## 3. Key Architectural Decisions & Storage Flow

### A. Dual Storage Strategy (Instant Paint + Cross-Device Sync)
1. **`browser.storage.local`**:
   - Stores `cachedLinks`, `cachedSpeedDialConfig`, `cachedSpeedDialOrder`, `bgImageData` (large base64 uploads).
   - Enables **0ms instant paint** when opening a new tab before any network requests fire.
2. **`browser.storage.sync`**:
   - Stores lightweight credentials and preferences (`linkwardenUrl`, `apiToken`, `selectedCollectionId`, `openInNewTab`, `syncToLinkwarden`, `backgroundColor`, `bgImageUrl`, `dialSize`, `maxColumns`, `defaultSort`).
   - Syncs settings across Firefox instances logged into the same Firefox account.

### B. Linkwarden Cloud Config Storage (`⚙️ Speed Dial Config`)
- Custom dial order and preferences (`dialSize`, `maxColumns`, `defaultSort`) are serialized as compact JSON inside a dedicated Linkwarden collection titled `⚙️ Speed Dial Config`.
- **CRITICAL LINKWARDEN API SCHEMA REQUIREMENT**:
  When updating the collection via `PUT /api/v1/collections/:id`, Linkwarden runs Zod validation (`UpdateCollectionSchema`). The request body **MUST** contain:
  ```json
  {
    "id": 123,
    "name": "⚙️ Speed Dial Config",
    "description": "{\"v\":1,\"order\":[...],\"dialSize\":\"medium\",\"maxColumns\":\"unlimited\",\"defaultSort\":\"newest_last\"}",
    "color": "#89b4fa",
    "members": [...]
  }
  ```
  *Note*: Omitting `id` (as a number) or `members` (as an array) will cause Linkwarden to reject the request with HTTP 400.
- Linkwarden's `description` column in PostgreSQL/Prisma is capped at 2048 characters. `serializeConfig()` in `newtab.js` automatically compacts keys and truncates lowest overflow items if total length exceeds 2040 bytes.

### C. High-Performance Grid & Event Delegation (Added in v1.3/v1.4)
- **Zero per-card event listeners**: `#grid` uses a single set of 6 delegated event listeners (`dragstart`, `dragover`, `dragleave`, `drop`, `dragend`, `click`).
- **Single Shared Dropdown**: Exactly one `.card-dropdown` element exists in the DOM. Clicking a 3-dot button `⋮` positions this single shared element via `getBoundingClientRect()`.
- **CSS Virtualization**: `.card` uses `content-visibility: auto; contain-intrinsic-size: var(--dial-width) var(--dial-height);`. Off-screen cards do not consume CPU/GPU layout passes until scrolled into view.
- **Lazy Favicons**: Favicon `<img>` elements use `loading="lazy"`.
- **Batch DOM Injection**: `renderGrid()` uses `document.createDocumentFragment()` and `gridEl.replaceChildren(fragment)` for single-tick reflow.

---

## 4. Implemented Features (v1.0 to v1.5)

1. **Right-Click Context Menu (v1.5)**: Replaced laggy 3-dot hover buttons with an instant custom right-click context menu featuring SVG icons:
   - **Open in new tab**: opens active foreground tab.
   - **Open in background tab**: opens inactive tab without losing focus.
   - **Open in new window**: launches clean window.
   - **Open in new private window**: launches incognito session (with fallback).
   - **Edit**: opens modal to edit bookmark name, URL, or collection.
   - **Delete**: shows quick confirmation dialog and deletes directly via API.
2. **Ultra-Fast "Potato PC" Optimizations (v1.5)**:
   - Stripped all hover transitions (`transition: none !important`), transforms (`translateY`), and expensive `backdrop-filter: blur`.
   - Cards render with zero extra buttons or hover elements, keeping layout and compositor trees minimal.
3. **Bookmark Editing Modal (v1.5)**: Allows in-place editing of title, URL, and collection, syncing via `PUT /api/v1/links/:id` on both Linkwarden and Mini-Linkwarden.
4. **Drag-and-Drop Dial Reordering**: Reorder cards by dragging; visual drop target indicators; prevents accidental link navigation during drag.
5. **Linkwarden Cloud Sync**: Custom layout order and settings persist into Linkwarden.
6. **Options Page**:
   - Connection tester for Linkwarden URL and API token.
   - Collection filter selector.
   - "Open in new tab" toggle.
   - Background Color picker (with live hex input and reset button).
   - Wallpaper options (HTTPS Image URL or local file upload).
   - Dial Size: `small`, `medium` (default), `large`.
   - Max Columns: `unlimited` (auto-fill), `3`, `4`, `5`, `6`, `7`, `8`, `9`, `10`.
   - Default Sort: `new dials last` (oldest first) vs `new dials first` (newest first).
   - One-click "Reset Dial Order" button.
7. **Add Bookmark from New Tab**: Floating `+` action button opens a modal allowing users to enter a URL, title, and target collection, posting directly to `POST /api/v1/links`.
8. **Optimized Large Collection Rendering**: Smooth 60+ FPS even with hundreds of bookmarks.
9. **Server Web Dashboard Firefox Bookmarks Import**: Built-in modal and API (`POST /api/v1/import/firefox` and `POST /api/v1/import`) to import Firefox bookmarks from Netscape HTML (`bookmarks.html`) or Firefox JSON backup (`bookmarks-*.json`). Supports drag & drop, instant preview, folder-to-collection mapping, merge vs replace modes (preserving speed dial config), and duplicate URL skipping.

---

## 5. Linkwarden API Endpoints Reference

| Action | HTTP Method & Route | Payload / Details |
|---|---|---|
| Fetch collections | `GET /api/v1/collections` | Bearer auth header |
| Create config collection | `POST /api/v1/collections` | `{ name: "⚙️ Speed Dial Config", description: "...", color: "#89b4fa" }` |
| Update config collection | `PUT /api/v1/collections/:id` | `{ id: number, name: string, description: string, color: string, members: array }` |
| Fetch bookmarks | `GET /api/v1/search?limit=100&cursor=...` or `/api/v1/links` | Paginated search endpoint |
| Create bookmark | `POST /api/v1/links` | `{ type: "url", url: string, name?: string, collection?: { id: number } }` |
| Update bookmark | `PUT /api/v1/links/:id` | `{ id: number, name?: string, url?: string, collection?: { id: number } }` |
| Delete bookmark | `DELETE /api/v1/links/:id` | Deletes link from Prisma database, file storage, and search index |
| Export database | `GET /api/v1/export` | Downloads JSON backup of all bookmarks and collections |
| Import backup | `POST /api/v1/import` | Restores database from Linkwarden / Mini-Linkwarden JSON or Firefox export |
| Import Firefox bookmarks | `POST /api/v1/import/firefox` | `{ items?: array, html?: string, content?: any, mode?: "merge"|"replace", createCollections?: boolean, targetCollectionId?: number, skipDuplicates?: boolean }` |

---

## 6. How to Test & Develop Locally

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **"Load Temporary Add-on..."** and select `c:\Users\charinrat\Desktop\linkwardendial\manifest.json`.
3. Click **"Inspect"** on the extension to open the developer console for error logs.
4. Open the extension options page to enter Linkwarden URL & API token.
5. Open a new tab (`Ctrl+T`) to view the speed dial.
6. When updating files:
   - Go to `about:debugging` and click **"Reload"** next to the extension.
   - Refresh the new tab.

---

## 7. Suggested Future Improvements / Roadmap

- **Search Bar**: Optional search bar at top of new tab to filter displayed bookmarks in real-time or search via Linkwarden / web.
- **Bookmark Editing**: Ability to edit bookmark title, URL, or collection directly from the 3-dot menu.
- **Folder / Collection Tabs**: Tabbed navigation at top of speed dial to quickly switch between collections without going to Options.
- **Keyboard Shortcuts**: Quick keyboard navigation or search shortcut (`/` to focus search).
- **Import/Export Config**: Export dial configuration to JSON backup file and import.

---

## 8. Mini-Linkwarden Docker & CI/CD Pipeline

- **Standalone Docker image**: Built via `server/Dockerfile` using `node:20-alpine`.
- **Automated CI/CD**: `.github/workflows/docker-publish.yml` automatically builds multi-arch (`linux/amd64`, `linux/arm64`) images and pushes to `ghcr.io/opaleiei/linkwardendial:latest` on every push to `main`.
- **Pull command**: `docker pull ghcr.io/opaleiei/linkwardendial:latest`
- **Docker Compose**: `docker compose up -d` uses the pre-built GHCR image with local build fallback.

