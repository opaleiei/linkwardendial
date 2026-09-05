# Linkwarden Speed Dial for Firefox

A modern, fast, and customizable Speed Dial new tab extension for Firefox powered by your self-hosted or cloud [Linkwarden](https://linkwarden.app) instance.

## Features

- **Drag & Drop Rearrangement**: Drag any bookmark dial to reorder it (e.g. drag your favorite bookmark straight to the top).
- **Linkwarden Cloud Config Storage**: Your custom dial order and settings are automatically synced and persisted directly into your Linkwarden instance (in a dedicated `⚙️ Speed Dial Config` collection).
- **Instant Paint / Local Cache**: Uses local cache for 0ms instant loading every time you open a new tab, then silently updates from Linkwarden in the background.
- **Customizable Background**: Pick any background color using the color picker / hex input, or set a background wallpaper using an online Image URL or by uploading a local image.
- **Delete Bookmarks Directly**: Hover over any bookmark card to reveal the 3-dot menu and delete the bookmark directly from your Linkwarden instance with one click.
- **Collection Filtering**: Choose to show bookmarks from all collections or a specific collection (e.g. "Speed Dial", "Favorites", or "Work").
- **Quick Settings & Order Reset**: Accessible settings from the corner button, complete with connection testing and a one-click button to reset order back to default.
- **Dark Catppuccin Theme**: Beautiful and clean dark interface with smooth hover, drag animations, and translucent frosted-glass cards.

## Setup

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **"Load Temporary Add-on..."** and select `manifest.json`.
3. Open the extension Options:
   - Enter your **Linkwarden Server URL** (e.g., `https://linkwarden.example.com`).
   - Enter your **API Access Token** (generated in Linkwarden under *Settings &rarr; Access Tokens*).
   - Click **"Test Connection"** to verify.
   - (Optional) Customize your background color or set a background wallpaper.
   - Choose whether you want to display all bookmarks or a specific collection.
   - Click **"Save Settings"**.
4. Open a new tab (`Ctrl+T`) and enjoy your Linkwarden Speed Dial!
