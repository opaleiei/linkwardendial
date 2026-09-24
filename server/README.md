# Mini-Linkwarden Server

A lightweight, zero-dependency bookmark server that mirrors the Linkwarden API endpoints used by the **Linkwarden Speed Dial** extension.

Instead of running a full Linkwarden instance with PostgreSQL, Meilisearch, Redis, and Playwright, you can run this tiny (~45MB) Docker container to store, reorder, add, and delete your bookmarks with sub-millisecond response times.

---

## Features

- **Linkwarden API Compatible**:
  - `GET /api/v1/collections` & `POST /api/v1/collections` & `PUT /api/v1/collections/:id` (collection and Speed Dial config persistence)
  - `GET /api/v1/search` & `GET /api/v1/links` (bookmark listing & collection filtering)
  - `POST /api/v1/links` (create bookmarks with automatic webpage title fetching)
  - `DELETE /api/v1/links/:id` (delete bookmarks)
- **Zero Heavy Dependencies**: Pure Node.js standard library with atomic file-based persistence (`db.json`).
- **CORS Enabled**: Out of the box support for browser extension requests.
- **Persistent Storage**: Data is saved to `/data/db.json` and mounted via Docker volume.
- **Configurable Auth**: Optional `API_TOKEN` environment variable.

---

## Pull Pre-Built Docker Image

You can pull and run the pre-built multi-architecture image directly from GitHub Container Registry (no build required):

```bash
docker pull ghcr.io/opaleiei/linkwardendial:latest
```

Run with `docker run`:
```bash
docker run -d \
  --name mini-linkwarden \
  -p 3000:3000 \
  -v $(pwd)/data:/data \
  -e PORT=3000 \
  -e API_TOKEN=mysecrettoken \
  --restart unless-stopped \
  ghcr.io/opaleiei/linkwardendial:latest
```

---

## Quick Start with Docker Compose

1. From the project root, start the container:
   ```bash
   docker compose up -d
   ```
   *(Pulls `ghcr.io/opaleiei/linkwardendial:latest` or builds locally if specified)*
2. The server will start on port `3000`.
3. In Firefox, open the Speed Dial Options page:
   - **Server URL**: `http://localhost:3000` (or `http://YOUR_SERVER_IP:3000`)
   - **API Access Token**: `mysecrettoken` (or whatever you set in `docker-compose.yml`)
   - Click **"Test Connection"**
   - Click **"Save Settings"**

---

## Web Dashboard

Visit `http://localhost:3000` in your web browser to view the built-in Catppuccin web dashboard with live bookmark counts, connection guide, and a one-click **"Download JSON Backup"** button (`/api/v1/export`).

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port for the HTTP server to listen on. |
| `API_TOKEN` | `""` | Optional secret token. If set, requires `Authorization: Bearer <API_TOKEN>`. If empty, authentication is open. |
| `DATA_DIR` | `/data` | Path where `db.json` is stored and persisted. |

---

## Data Backup & Migration

All bookmarks and dial settings are saved cleanly in a single human-readable JSON file:
`./data/db.json`.

You can backup, inspect, or copy this file anywhere!
