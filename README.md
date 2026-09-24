100% Vibe coded using free tier Google Antigravity

# Linkwarden Speed Dial for Firefox

A modern, fast, and customizable Speed Dial new tab extension for Firefox powered by your self-hosted or cloud [Linkwarden](https://linkwarden.app) instance.

## Features

- **Drag & Drop Rearrangement**: Drag any bookmark dial to reorder it (e.g. drag your favorite bookmark straight to the top).
- **Linkwarden Cloud Config Storage**: Your custom dial order and settings are automatically synced and persisted directly into your Linkwarden instance (in a dedicated `⚙️ Speed Dial Config` collection).
- **Instant Paint / Local Cache**: Uses local cache for 0ms instant loading every time you open a new tab, then silently updates from Linkwarden in the background.
- **Customizable Dial Sizes**: Choose between **Small**, **Medium** (default), or **Large** dials to suit your monitor and aesthetic preferences.
- **Configurable Grid Columns**: Set maximum columns per row (3 to 10 columns, or **Unlimited / Auto-fill**).
- **Default Sort Control**: Choose whether new unarranged dials appear **first** or **last**.
- **Add Bookmarks Directly**: Floating `+` button on the new tab page opens an Add Bookmark modal that saves directly to your Linkwarden instance.
- **Delete Bookmarks Directly**: Hover over any bookmark card to reveal the 3-dot menu and delete the bookmark directly from Linkwarden with one click.
- **Customizable Background**: Pick any background color using the color picker / hex input, or set a background wallpaper using an online Image URL or by uploading a local image.
- **Collection Filtering**: Choose to show bookmarks from all collections or a specific collection (e.g. "Speed Dial", "Favorites", or "Work").
- **High-Performance Architecture**: Zero-lag rendering with event delegation, lazy-loaded favicons, and CSS content-visibility for collections with hundreds of bookmarks.
- **Dark Catppuccin Theme**: Beautiful, clean dark interface with smooth hover and drag animations.

## Setup

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **"Load Temporary Add-on..."** and select `manifest.json`.
3. Open the extension Options:
   - Enter your **Linkwarden Server URL** (e.g., `https://linkwarden.example.com`).
   - Enter your **API Access Token** (generated in Linkwarden under *Settings &rarr; Access Tokens*).
   - Click **"Test Connection"** to verify.
   - (Optional) Customize your dial size, max columns, sort order, and background.
   - Choose whether you want to display all bookmarks or a specific collection.
   - Click **"Save Settings"**.
4. Open a new tab (`Ctrl+T`) and enjoy your Linkwarden Speed Dial!

## Mini-Linkwarden Docker Backend (Optional Alternative)

Don't want to run the full Linkwarden suite? A lightweight, zero-dependency backend is included in `server/` that mimics Linkwarden's bookmark and collection endpoints:

1. Start the mini-server with Docker Compose:
   ```bash
   docker compose up -d
   ```
2. In the extension Options:
   - **Server URL**: `http://localhost:3000`
   - **API Access Token**: `mysecrettoken` (configured in `docker-compose.yml`)
3. All bookmarks, collections, and custom dial arrangements are saved to `./data/db.json`.

See [server/README.md](server/README.md) for more details.

## Development & Handover

For developers or AI agents picking up this project, see [HANDOVER.md](HANDOVER.md) for full architecture notes, Linkwarden API quirks, and testing guidelines.
