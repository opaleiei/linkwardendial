const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const API_TOKEN = process.env.API_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory state
let db = {
  nextLinkId: 1,
  nextCollectionId: 2,
  collections: [
    {
      id: 1,
      name: 'Unorganized',
      description: '',
      color: '#89b4fa',
      members: [{ userId: 1, canCreate: true, canUpdate: true, canDelete: true }]
    }
  ],
  links: []
};

// Load database from disk if it exists
if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    db = JSON.parse(raw);
    console.log(`[Mini-Linkwarden] Loaded database: ${db.links.length} links, ${db.collections.length} collections.`);
  } catch (err) {
    console.error('[Mini-Linkwarden] Error reading db.json, starting with fresh database:', err);
  }
} else {
  saveDb();
}

function saveDb() {
  try {
    const tempFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error('[Mini-Linkwarden] Failed to save db.json:', err);
  }
}

// Helper: send JSON response
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept'
  });
  res.end(JSON.stringify(data));
}

// Helper: parse JSON request body
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) { // Allow up to 50MB for large bookmark imports
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

// Helper: scrape webpage title
async function fetchPageTitle(targetUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 MiniLinkwarden/1.0'
      }
    });
    clearTimeout(timeout);

    if (!response.ok) return null;
    const html = await response.text();
    const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return match ? match[1].trim() : null;
  } catch (e) {
    return null;
  }
}

// Helper: import and normalize backup data
function importBackupData(payload) {
  let importedCollections = [];
  let importedLinks = [];

  // Case 1: Standard Mini-Linkwarden backup / db.json
  if (payload && Array.isArray(payload.collections) && Array.isArray(payload.links)) {
    importedCollections = payload.collections;
    importedLinks = payload.links;
  }
  // Case 2: Array of links or official Linkwarden links export
  else if (Array.isArray(payload)) {
    importedLinks = payload;
  } else if (payload && Array.isArray(payload.links)) {
    importedLinks = payload.links;
    if (Array.isArray(payload.collections)) importedCollections = payload.collections;
  } else if (payload && Array.isArray(payload.response)) {
    importedLinks = payload.response;
  } else if (payload && payload.response && Array.isArray(payload.response.links)) {
    importedLinks = payload.response.links;
  }

  // Ensure default collection exists
  if (importedCollections.length === 0) {
    importedCollections = [
      {
        id: 1,
        name: 'Unorganized',
        description: '',
        color: '#89b4fa',
        members: [{ userId: 1, canCreate: true, canUpdate: true, canDelete: true }]
      }
    ];
  }

  // Normalize links
  let linkIdCounter = 1;
  const normalizedLinks = importedLinks.map((item, idx) => {
    const linkId = typeof item.id === 'number' ? item.id : linkIdCounter++;
    const targetUrl = item.url || '';
    let domain = '';
    try {
      if (targetUrl) domain = new URL(targetUrl).hostname;
    } catch (_) {}

    return {
      id: linkId,
      name: item.name || item.title || targetUrl || `Bookmark ${idx + 1}`,
      url: targetUrl,
      description: item.description || '',
      type: item.type || 'url',
      favIcon: item.favIcon || (domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : null),
      collectionId: item.collectionId || (item.collection && item.collection.id) || 1,
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || new Date().toISOString()
    };
  }).filter(l => Boolean(l.url));

  // Determine next IDs
  const maxLinkId = normalizedLinks.reduce((max, l) => Math.max(max, l.id || 0), 0);
  const maxColId = importedCollections.reduce((max, c) => Math.max(max, c.id || 0), 0);

  db.collections = importedCollections;
  db.links = normalizedLinks;
  db.nextLinkId = maxLinkId + 1;
  db.nextCollectionId = maxColId + 1;

  saveDb();
  console.log(`[Mini-Linkwarden] Imported ${db.links.length} bookmarks and ${db.collections.length} collections.`);
  return { linksCount: db.links.length, collectionsCount: db.collections.length };
}

// Dashboard HTML generator
function renderDashboardHtml(host) {
  const linksHtml = db.links.length === 0
    ? '<p style="color: #6c7086; font-style: italic;">No bookmarks saved yet. Use the Linkwarden Speed Dial extension or click Import Backup below to get started!</p>'
    : db.links.map(l => `
      <div style="background: #181825; border: 1px solid #313244; border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 12px; overflow: hidden;">
          <img src="${l.favIcon || 'https://www.google.com/s2/favicons?domain=' + (new URL(l.url).hostname) + '&sz=32'}" width="20" height="20" style="object-fit: contain;" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🌐</text></svg>'">
          <a href="${l.url}" target="_blank" rel="noopener noreferrer" style="color: #cdd6f4; text-decoration: none; font-weight: 500; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${escapeHtml(l.name || l.url)}</a>
        </div>
        <span style="font-size: 11px; color: #6c7086; margin-left: 12px; white-space: nowrap;">ID: ${l.id}</span>
      </div>
    `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Mini-Linkwarden Server</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #11111b;
      color: #cdd6f4;
      margin: 0;
      padding: 40px 20px;
      display: flex;
      justify-content: center;
    }
    .container {
      max-width: 680px;
      width: 100%;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      border-bottom: 1px solid #313244;
      padding-bottom: 16px;
    }
    h1 {
      margin: 0;
      color: #89b4fa;
      font-size: 24px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .badge {
      background: rgba(166, 227, 161, 0.15);
      color: #a6e3a1;
      border: 1px solid #a6e3a1;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .card {
      background: #1e1e2e;
      border: 1px solid #313244;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .card h2 {
      margin-top: 0;
      margin-bottom: 14px;
      font-size: 16px;
      color: #89b4fa;
    }
    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 16px;
    }
    .stat-box {
      background: #181825;
      border: 1px solid #313244;
      border-radius: 8px;
      padding: 14px;
      text-align: center;
    }
    .stat-number {
      font-size: 26px;
      font-weight: bold;
      color: #cdd6f4;
    }
    .stat-label {
      font-size: 12px;
      color: #a6adc8;
      margin-top: 4px;
    }
    code {
      background: #313244;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 13px;
      color: #f5c2e7;
    }
    .btn-row {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #89b4fa;
      color: #11111b;
      padding: 9px 18px;
      border-radius: 6px;
      text-decoration: none;
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
      border: none;
      transition: opacity 0.2s;
    }
    .btn:hover {
      opacity: 0.9;
    }
    .btn.secondary {
      background: #313244;
      color: #cdd6f4;
      border: 1px solid #45475a;
    }
    .btn.secondary:hover {
      background: #45475a;
    }
    #importStatus {
      margin-top: 12px;
      font-size: 13px;
      font-weight: 500;
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🚀 Mini-Linkwarden</h1>
      <span class="badge">● Online</span>
    </div>

    <div class="card">
      <h2>📊 Server Stats & Backup</h2>
      <div class="stats">
        <div class="stat-box">
          <div class="stat-number" id="stats-links">${db.links.length}</div>
          <div class="stat-label">Saved Bookmarks</div>
        </div>
        <div class="stat-box">
          <div class="stat-number" id="stats-collections">${db.collections.length}</div>
          <div class="stat-label">Collections</div>
        </div>
      </div>
      <div class="btn-row">
        <a href="/api/v1/export" class="btn" download>📥 Download JSON Backup</a>
        <label class="btn secondary" style="cursor: pointer; margin: 0;">
          📤 Import Backup
          <input type="file" id="importFileInput" accept=".json,application/json" style="display: none;">
        </label>
      </div>
      <div id="importStatus"></div>
    </div>

    <div class="card">
      <h2>🔗 Extension Setup Guide</h2>
      <p style="margin-top: 0; color: #a6adc8; font-size: 14px; line-height: 1.6;">
        To connect your <strong>Linkwarden Speed Dial</strong> extension to this server:
      </p>
      <ol style="color: #cdd6f4; font-size: 14px; line-height: 1.8; margin-bottom: 0; padding-left: 20px;">
        <li>Open Firefox &rarr; Speed Dial Options (or click ⚙ in bottom-right of new tab).</li>
        <li>Set <strong>Linkwarden Server URL</strong> to: <code>http://${host || 'localhost:' + PORT}</code></li>
        <li>Set <strong>API Access Token</strong> to: <code>${API_TOKEN || '(Empty / any string)'}</code></li>
        <li>Click <strong>Test Connection</strong>, then <strong>Save Settings</strong>.</li>
      </ol>
    </div>

    <div class="card">
      <h2>🔖 Bookmarks (${db.links.length})</h2>
      <div id="bookmarks-list">
        ${linksHtml}
      </div>
    </div>
  </div>

  <script>
    document.getElementById('importFileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (!confirm('Are you sure you want to import "' + file.name + '"? This will load the bookmarks and collections from the backup.')) {
        e.target.value = '';
        return;
      }

      const statusEl = document.getElementById('importStatus');
      statusEl.style.display = 'block';
      statusEl.style.color = '#89b4fa';
      statusEl.textContent = '⏳ Importing backup...';

      try {
        const text = await file.text();
        const data = JSON.parse(text);

        const res = await fetch('/api/v1/import', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ${API_TOKEN ? `'Authorization': 'Bearer ${API_TOKEN}'` : "'' : ''"}
          },
          body: JSON.stringify(data)
        });

        const json = await res.json();
        if (res.ok) {
          statusEl.style.color = '#a6e3a1';
          statusEl.textContent = '✓ ' + (json.response || 'Backup imported successfully!') + ' Reloading dashboard...';
          setTimeout(() => window.location.reload(), 1000);
        } else {
          statusEl.style.color = '#f38ba8';
          statusEl.textContent = '❌ Error: ' + (json.response || 'Failed to import backup');
        }
      } catch (err) {
        statusEl.style.color = '#f38ba8';
        statusEl.textContent = '❌ Error reading file: ' + err.message;
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Request dispatcher
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept'
    });
    return res.end();
  }

  // Token authentication check (if API_TOKEN is set)
  if (API_TOKEN) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token !== API_TOKEN && pathname.startsWith('/api/')) {
      return sendJson(res, 401, { response: 'Unauthorized: Invalid API Token' });
    }
  }

  // 1. Health check & Web Dashboard
  if (pathname === '/' || pathname === '/health') {
    const acceptHeader = req.headers['accept'] || '';
    if (pathname === '/' && acceptHeader.includes('text/html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderDashboardHtml(req.headers.host));
    }

    return sendJson(res, 200, {
      status: 'ok',
      service: 'mini-linkwarden',
      version: '1.0.0',
      linksCount: db.links.length,
      collectionsCount: db.collections.length
    });
  }

  // 2. Export database
  if (pathname === '/api/v1/export' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="linkwarden-bookmarks-backup.json"',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(JSON.stringify(db, null, 2));
  }

  // 3. Import database / restore backup
  if (pathname === '/api/v1/import' && method === 'POST') {
    const body = await parseBody(req);
    if (!body || (typeof body !== 'object')) {
      return sendJson(res, 400, { response: 'Invalid JSON payload for import' });
    }

    try {
      const stats = importBackupData(body);
      return sendJson(res, 200, {
        response: `Successfully imported ${stats.linksCount} bookmarks and ${stats.collectionsCount} collections.`,
        status: 200,
        linksCount: stats.linksCount,
        collectionsCount: stats.collectionsCount
      });
    } catch (err) {
      console.error('[Mini-Linkwarden] Import error:', err);
      return sendJson(res, 500, { response: `Import failed: ${err.message}` });
    }
  }

  // 4. Collections endpoints
  // GET /api/v1/collections
  if (pathname === '/api/v1/collections' && method === 'GET') {
    return sendJson(res, 200, { response: db.collections });
  }

  // POST /api/v1/collections
  if (pathname === '/api/v1/collections' && method === 'POST') {
    const body = await parseBody(req);
    const newCollection = {
      id: db.nextCollectionId++,
      name: String(body.name || 'New Collection').trim(),
      description: String(body.description || ''),
      color: body.color || '#89b4fa',
      members: [{ userId: 1, canCreate: true, canUpdate: true, canDelete: true }]
    };
    db.collections.push(newCollection);
    saveDb();
    console.log(`[Mini-Linkwarden] Created collection "${newCollection.name}" (id: ${newCollection.id})`);
    return sendJson(res, 200, { response: newCollection });
  }

  // PUT /api/v1/collections/:id
  const putCollectionMatch = pathname.match(/^\/api\/v1\/collections\/(\d+)$/);
  if (putCollectionMatch && method === 'PUT') {
    const id = parseInt(putCollectionMatch[1], 10);
    const body = await parseBody(req);
    const collection = db.collections.find(c => c.id === id);

    if (!collection) {
      return sendJson(res, 404, { response: 'Collection not found' });
    }

    if (body.name !== undefined) collection.name = String(body.name).trim();
    if (body.description !== undefined) collection.description = String(body.description);
    if (body.color !== undefined) collection.color = String(body.color);
    if (Array.isArray(body.members)) collection.members = body.members;

    saveDb();
    return sendJson(res, 200, { response: collection });
  }

  // DELETE /api/v1/collections/:id
  const deleteCollectionMatch = pathname.match(/^\/api\/v1\/collections\/(\d+)$/);
  if (deleteCollectionMatch && method === 'DELETE') {
    const id = parseInt(deleteCollectionMatch[1], 10);
    const index = db.collections.findIndex(c => c.id === id);
    if (index === -1) {
      return sendJson(res, 404, { response: 'Collection not found' });
    }
    const removed = db.collections.splice(index, 1)[0];
    db.links = db.links.filter(l => l.collectionId !== id);
    saveDb();
    return sendJson(res, 200, { response: removed });
  }

  // 5. Search / Links listing endpoints
  // GET /api/v1/search OR GET /api/v1/links
  if ((pathname === '/api/v1/search' || pathname === '/api/v1/links') && method === 'GET') {
    const colParam = reqUrl.searchParams.get('collectionId');
    const collectionId = colParam ? parseInt(colParam, 10) : null;
    let links = db.links;

    if (collectionId) {
      links = links.filter(l => l.collectionId === collectionId);
    }

    return sendJson(res, 200, {
      response: {
        links: links,
        nextCursor: null
      }
    });
  }

  // 6. Create Bookmark
  // POST /api/v1/links
  if (pathname === '/api/v1/links' && method === 'POST') {
    const body = await parseBody(req);
    let targetUrl = (body.url || '').trim();

    if (!targetUrl) {
      return sendJson(res, 400, { response: 'Missing required field: url' });
    }

    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = 'https://' + targetUrl;
    }

    let name = (body.name || '').trim();
    if (!name) {
      const scrapedTitle = await fetchPageTitle(targetUrl);
      name = scrapedTitle || targetUrl;
    }

    let collectionId = body.collection && body.collection.id ? parseInt(body.collection.id, 10) : 1;
    if (!db.collections.some(c => c.id === collectionId)) {
      collectionId = 1;
    }

    let domain = '';
    try {
      domain = new URL(targetUrl).hostname;
    } catch (_) {}

    const newLink = {
      id: db.nextLinkId++,
      name: name,
      url: targetUrl,
      description: body.description || '',
      type: 'url',
      favIcon: domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : null,
      collectionId: collectionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.links.push(newLink);
    saveDb();
    console.log(`[Mini-Linkwarden] Added bookmark "${newLink.name}" (${newLink.url})`);
    return sendJson(res, 200, { response: newLink, status: 200 });
  }

  // 7. Delete Bookmark
  // DELETE /api/v1/links/:id
  const deleteLinkMatch = pathname.match(/^\/api\/v1\/links\/(\d+)$/);
  if (deleteLinkMatch && method === 'DELETE') {
    const id = parseInt(deleteLinkMatch[1], 10);
    const index = db.links.findIndex(l => l.id === id);

    if (index === -1) {
      return sendJson(res, 404, { response: 'Bookmark not found' });
    }

    const deletedLink = db.links.splice(index, 1)[0];
    saveDb();
    console.log(`[Mini-Linkwarden] Deleted bookmark id ${id} ("${deletedLink.name}")`);
    return sendJson(res, 200, { response: deletedLink, status: 200 });
  }

  // 404 Not Found
  return sendJson(res, 404, { response: `Endpoint not found: ${method} ${pathname}` });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🚀 Mini-Linkwarden running at http://0.0.0.0:${PORT}`);
  console.log(`📁 Data directory: ${DATA_DIR}`);
  console.log(`🔑 API Token: ${API_TOKEN ? '[Configured]' : '[Disabled / Open]'}`);
  console.log(`=======================================================`);
});
