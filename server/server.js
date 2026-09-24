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

// Helper: decode HTML entities
function decodeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Helper: parse Firefox Netscape HTML bookmark format
function parseFirefoxHtml(html) {
  const bookmarks = [];
  const folderStack = [];
  let pendingFolder = null;
  let lastItem = null;

  const tokenRegex = /<H3([^>]*)>(.*?)<\/H3>|<DL\b[^>]*>|<\/DL>|<A\s+([^>]+)>(.*?)<\/A>|<DD>(.*?)(?=(?:<DT|<DL|<\/DL|<p|\n|$))/gis;

  let match;
  while ((match = tokenRegex.exec(html)) !== null) {
    const raw = match[0];
    if (/^<H3/i.test(raw)) {
      pendingFolder = decodeHtml(match[2].trim());
      lastItem = null;
    } else if (/^<DL/i.test(raw)) {
      folderStack.push(pendingFolder || '');
      pendingFolder = null;
      lastItem = null;
    } else if (/^<\/DL/i.test(raw)) {
      folderStack.pop();
      lastItem = null;
    } else if (/^<A/i.test(raw)) {
      const attrs = match[3];
      const title = decodeHtml(match[4].trim());

      const hrefMatch = attrs.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const url = hrefMatch ? (hrefMatch[1] || hrefMatch[2] || hrefMatch[3]) : '';

      const iconMatch = attrs.match(/icon\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const icon = iconMatch ? (iconMatch[1] || iconMatch[2] || iconMatch[3]) : '';

      let currentFolder = '';
      for (let i = folderStack.length - 1; i >= 0; i--) {
        if (folderStack[i]) {
          currentFolder = folderStack[i];
          break;
        }
      }

      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        const item = {
          name: title || url,
          url: url,
          favIcon: icon || null,
          folder: currentFolder || 'Unorganized',
          folderPath: folderStack.filter(Boolean),
          description: ''
        };
        bookmarks.push(item);
        lastItem = item;
      }
    } else if (/^<DD/i.test(raw)) {
      if (lastItem) {
        lastItem.description = decodeHtml(match[5].trim());
      }
    }
  }

  return bookmarks;
}

// Helper: parse Firefox JSON backup format
function parseFirefoxJson(root) {
  const bookmarks = [];

  function walk(node, folderPath) {
    if (!node) return;

    const isBookmark = Boolean(node.uri || node.url) && (node.typeCode === 1 || node.type === 'text/x-moz-place' || !node.children);
    if (isBookmark) {
      const url = node.uri || node.url;
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        const currentFolder = folderPath.length > 0 ? folderPath[folderPath.length - 1] : 'Unorganized';
        bookmarks.push({
          name: node.title || url,
          url: url,
          favIcon: node.iconuri || node.icon || null,
          folder: currentFolder,
          folderPath: [...folderPath],
          description: node.description || ''
        });
      }
      return;
    }

    const hasChildren = Array.isArray(node.children);
    const nextPath = [...folderPath];
    if (node.title && node.title !== 'root' && node.guid !== 'root________') {
      nextPath.push(node.title.trim());
    }

    if (hasChildren) {
      for (const child of node.children) {
        walk(child, nextPath);
      }
    }
  }

  walk(root, []);
  return bookmarks;
}

// Helper: parse any Firefox bookmark data (HTML, JSON, or array)
function parseFirefoxBookmarks(data) {
  if (Array.isArray(data)) return data;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return parseFirefoxJson(JSON.parse(trimmed));
      } catch (_) {}
    }
    return parseFirefoxHtml(data);
  }
  if (typeof data === 'object' && data !== null) {
    return parseFirefoxJson(data);
  }
  return [];
}

// Helper: import Firefox bookmarks into database
function importFirefoxData({ bookmarks, mode = 'merge', createCollections = true, targetCollectionId = 1, skipDuplicates = true }) {
  if (!Array.isArray(bookmarks) || bookmarks.length === 0) {
    return {
      importedCount: 0,
      collectionsCreated: 0,
      skippedDuplicates: 0,
      totalLinks: db.links.length,
      totalCollections: db.collections.length
    };
  }

  const catppuccinColors = [
    '#89b4fa', '#a6e3a1', '#f9e2af', '#fab387', '#f38ba8',
    '#cba6f7', '#b4befe', '#74c7ec', '#89dceb', '#94e2d5'
  ];

  let speedDialConfigCollection = null;
  if (mode === 'replace') {
    speedDialConfigCollection = db.collections.find(c => c.name === '⚙️ Speed Dial Config');
    db.links = [];
    db.collections = [
      {
        id: 1,
        name: 'Unorganized',
        description: '',
        color: '#89b4fa',
        members: [{ userId: 1, canCreate: true, canUpdate: true, canDelete: true }]
      }
    ];
    if (speedDialConfigCollection) {
      db.collections.push(speedDialConfigCollection);
    }
    db.nextLinkId = 1;
    db.nextCollectionId = Math.max(...db.collections.map(c => c.id), 1) + 1;
  }

  const collectionNameMap = new Map();
  for (const col of db.collections) {
    collectionNameMap.set(col.name.trim().toLowerCase(), col.id);
  }

  let collectionsCreated = 0;
  function getOrCreateCollection(name) {
    const trimmed = (name || '').trim();
    if (!trimmed || trimmed.toLowerCase() === 'unorganized') {
      return 1;
    }
    const lower = trimmed.toLowerCase();
    if (collectionNameMap.has(lower)) {
      return collectionNameMap.get(lower);
    }
    const newId = db.nextCollectionId++;
    const colColor = catppuccinColors[(db.collections.length) % catppuccinColors.length];
    const newCol = {
      id: newId,
      name: trimmed,
      description: 'Imported from Firefox',
      color: colColor,
      members: [{ userId: 1, canCreate: true, canUpdate: true, canDelete: true }]
    };
    db.collections.push(newCol);
    collectionNameMap.set(lower, newId);
    collectionsCreated++;
    return newId;
  }

  const existingUrls = new Set(
    mode === 'merge' && skipDuplicates
      ? db.links.map(l => l.url.trim().toLowerCase())
      : []
  );

  let importedCount = 0;
  let skippedDuplicates = 0;

  for (const item of bookmarks) {
    const targetUrl = (item.url || '').trim();
    if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
      continue;
    }

    const normUrl = targetUrl.toLowerCase();
    if (mode === 'merge' && skipDuplicates && existingUrls.has(normUrl)) {
      skippedDuplicates++;
      continue;
    }

    let colId = 1;
    if (createCollections) {
      colId = getOrCreateCollection(item.folder);
    } else {
      colId = parseInt(targetCollectionId, 10) || 1;
      if (!db.collections.some(c => c.id === colId)) {
        colId = 1;
      }
    }

    let domain = '';
    try {
      domain = new URL(targetUrl).hostname;
    } catch (_) {}

    const newLink = {
      id: db.nextLinkId++,
      name: (item.name || targetUrl).trim(),
      url: targetUrl,
      description: item.description || '',
      type: 'url',
      favIcon: item.favIcon || (domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : null),
      collectionId: colId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.links.push(newLink);
    existingUrls.add(normUrl);
    importedCount++;
  }

  saveDb();
  console.log(`[Mini-Linkwarden] Imported ${importedCount} Firefox bookmarks (${collectionsCreated} collections created, ${skippedDuplicates} duplicates skipped).`);

  return {
    importedCount,
    collectionsCreated,
    skippedDuplicates,
    totalLinks: db.links.length,
    totalCollections: db.collections.length
  };
}

// Helper: import and normalize backup data
function importBackupData(payload) {
  // Case: Firefox JSON backup
  if (payload && (payload.guid || (payload.type && String(payload.type).includes('moz')) || (payload.children && Array.isArray(payload.children)))) {
    const ffBookmarks = parseFirefoxJson(payload);
    const stats = importFirefoxData({ bookmarks: ffBookmarks, mode: 'replace', createCollections: true });
    return { linksCount: stats.importedCount, collectionsCount: stats.collectionsCreated };
  }

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
  const collectionOptionsHtml = db.collections
    .filter(c => c.name !== '⚙️ Speed Dial Config')
    .map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
    .join('');

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
    .btn.firefox-btn {
      background: linear-gradient(135deg, #ff7139 0%, #e22d64 50%, #902cbe 100%);
      color: #ffffff;
      border: none;
      box-shadow: 0 2px 8px rgba(226, 45, 100, 0.25);
    }
    .btn.firefox-btn:hover {
      opacity: 0.92;
      filter: brightness(1.08);
    }
    #importStatus {
      margin-top: 12px;
      font-size: 13px;
      font-weight: 500;
      display: none;
    }
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 16px;
      backdrop-filter: blur(3px);
    }
    .modal-overlay.active {
      display: flex;
    }
    .modal-card {
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 12px;
      width: 100%;
      max-width: 540px;
      padding: 24px;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.6);
      box-sizing: border-box;
      max-height: 90vh;
      overflow-y: auto;
    }
    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 18px;
      border-bottom: 1px solid #313244;
      padding-bottom: 12px;
    }
    .modal-close {
      background: none;
      border: none;
      color: #a6adc8;
      font-size: 24px;
      cursor: pointer;
      padding: 0;
      line-height: 1;
    }
    .modal-close:hover {
      color: #f38ba8;
    }
    .drop-zone {
      border: 2px dashed #45475a;
      border-radius: 10px;
      padding: 28px 16px;
      text-align: center;
      background: #181825;
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s;
    }
    .drop-zone:hover, .drop-zone.dragover {
      border-color: #fab387;
      background: #1e1e2e;
    }
    .radio-option {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin-bottom: 10px;
      cursor: pointer;
      font-size: 13px;
      color: #cdd6f4;
    }
    .radio-option input[type="radio"], .radio-option input[type="checkbox"] {
      margin-top: 2px;
      accent-color: #fab387;
    }
    kbd {
      background: #313244;
      color: #cdd6f4;
      border: 1px solid #45475a;
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 11px;
      font-family: inherit;
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
        <button type="button" class="btn firefox-btn" id="openFirefoxModalBtn" style="cursor: pointer;">
          🦊 Import Firefox Bookmarks
        </button>
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

    <!-- Firefox Import Modal -->
    <div id="firefoxModal" class="modal-overlay">
      <div class="modal-card">
        <div class="modal-header">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 20px;">🦊</span>
            <h3 style="margin: 0; font-size: 18px; color: #fab387;">Import Firefox Bookmarks</h3>
          </div>
          <button type="button" class="modal-close" id="closeFirefoxModal" aria-label="Close modal">&times;</button>
        </div>

        <!-- Step 1: File Selection -->
        <div id="ffStepSelect">
          <div class="drop-zone" id="ffDropZone">
            <div style="font-size: 36px; margin-bottom: 8px;">📂</div>
            <p style="margin: 0 0 6px 0; font-weight: 600; font-size: 15px; color: #cdd6f4;">Choose or Drop Firefox Bookmarks File</p>
            <p style="margin: 0; font-size: 12px; color: #a6adc8;">
              Supports <code style="color: #fab387;">bookmarks.html</code> (Netscape HTML) or <code style="color: #fab387;">bookmarks-*.json</code>
            </p>
            <input type="file" id="ffFileInput" accept=".html,.htm,.json,text/html,application/json" style="display: none;">
          </div>
          <div style="background: #181825; border: 1px solid #313244; border-radius: 8px; padding: 12px 14px; margin-top: 14px; font-size: 12px; color: #a6adc8; line-height: 1.6;">
            <strong style="color: #cdd6f4;">💡 How to export bookmarks in Firefox:</strong><br>
            1. Press <kbd>Ctrl+Shift+O</kbd> (<kbd>Cmd+Shift+O</kbd> on Mac) to open Library.<br>
            2. Click <strong>Import and Backup</strong> in the toolbar.<br>
            3. Click <strong>Export Bookmarks to HTML...</strong> (recommended) or <strong>Backup...</strong>
          </div>
        </div>

        <!-- Step 2: File Options -->
        <div id="ffStepOptions" style="display: none;">
          <div style="background: #181825; border: 1px solid #313244; border-radius: 8px; padding: 12px 14px; margin-bottom: 16px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div style="font-weight: 600; color: #a6e3a1; font-size: 14px;" id="ffFileInfo">✓ Ready</div>
              <button type="button" class="btn secondary" id="ffChangeFileBtn" style="padding: 4px 10px; font-size: 11px;">Change File</button>
            </div>
            <div style="font-size: 12px; color: #a6adc8; margin-top: 5px;" id="ffFoldersInfo">Folders detected</div>
          </div>

          <div style="margin-bottom: 16px;">
            <label style="font-size: 13px; font-weight: 600; color: #cdd6f4; display: block; margin-bottom: 8px;">Import Mode</label>
            <label class="radio-option">
              <input type="radio" name="ffMode" value="merge" checked>
              <span><strong>Merge</strong> &mdash; Add new bookmarks, keep existing ones (Recommended)</span>
            </label>
            <label class="radio-option">
              <input type="radio" name="ffMode" value="replace">
              <span><strong>Replace</strong> &mdash; Clear existing bookmarks and replace with these</span>
            </label>
          </div>

          <div style="margin-bottom: 16px;">
            <label style="font-size: 13px; font-weight: 600; color: #cdd6f4; display: block; margin-bottom: 8px;">Collection Organization</label>
            <label class="radio-option">
              <input type="radio" name="ffCollections" value="auto" checked>
              <span>Create collections from Firefox folders (<span id="ffFolderListPreview" style="color: #89b4fa;"></span>)</span>
            </label>
            <label class="radio-option">
              <input type="radio" name="ffCollections" value="single">
              <span>Import all bookmarks into one collection:</span>
              <select id="ffSingleCollectionSelect" style="background: #181825; color: #cdd6f4; border: 1px solid #45475a; border-radius: 4px; padding: 3px 8px; margin-left: 6px; font-size: 12px;">
                ${collectionOptionsHtml}
              </select>
            </label>
          </div>

          <div style="margin-bottom: 20px;">
            <label class="radio-option">
              <input type="checkbox" id="ffSkipDuplicates" checked>
              <span>Skip duplicate URLs if they already exist in database</span>
            </label>
          </div>

          <div class="btn-row" style="justify-content: flex-end;">
            <button type="button" class="btn secondary" id="ffCancelBtn">Cancel</button>
            <button type="button" class="btn firefox-btn" id="ffSubmitBtn">Import Bookmarks</button>
          </div>
        </div>

        <!-- Step 3: Result / Loading -->
        <div id="ffStepResult" style="display: none; text-align: center; padding: 24px 0;">
          <div id="ffResultSpinner" style="font-size: 34px; margin-bottom: 12px;">⏳</div>
          <div id="ffResultText" style="font-size: 14px; font-weight: 500; color: #cdd6f4;">Importing bookmarks...</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    // Standard Backup Import
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
        let data;
        try {
          data = JSON.parse(text);
        } catch (_) {
          data = { html: text };
        }

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

    // 🦊 Firefox Bookmark Import Logic
    let parsedFfBookmarks = [];

    function decodeEntities(str) {
      if (!str) return '';
      return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#(\\d+);/g, (_, dec) => String.fromCharCode(dec))
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }

    function clientParseFirefoxHtml(html) {
      const bookmarks = [];
      const folderStack = [];
      let pendingFolder = null;
      let lastItem = null;

      const tokenRegex = /<H3([^>]*)>(.*?)<\\/H3>|<DL\\b[^>]*>|<\\/DL>|<A\\s+([^>]+)>(.*?)<\\/A>|<DD>(.*?)(?=(?:<DT|<DL|<\\/DL|<p|\\n|$))/gis;

      let match;
      while ((match = tokenRegex.exec(html)) !== null) {
        const raw = match[0];
        if (/^<H3/i.test(raw)) {
          pendingFolder = decodeEntities(match[2].trim());
          lastItem = null;
        } else if (/^<DL/i.test(raw)) {
          folderStack.push(pendingFolder || '');
          pendingFolder = null;
          lastItem = null;
        } else if (/^<\\/DL/i.test(raw)) {
          folderStack.pop();
          lastItem = null;
        } else if (/^<A/i.test(raw)) {
          const attrs = match[3];
          const title = decodeEntities(match[4].trim());

          const hrefMatch = attrs.match(/href\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))/i);
          const url = hrefMatch ? (hrefMatch[1] || hrefMatch[2] || hrefMatch[3]) : '';

          const iconMatch = attrs.match(/icon\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))/i);
          const icon = iconMatch ? (iconMatch[1] || iconMatch[2] || iconMatch[3]) : '';

          let currentFolder = '';
          for (let i = folderStack.length - 1; i >= 0; i--) {
            if (folderStack[i]) {
              currentFolder = folderStack[i];
              break;
            }
          }

          if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
            const item = {
              name: title || url,
              url: url,
              favIcon: icon || null,
              folder: currentFolder || 'Unorganized',
              description: ''
            };
            bookmarks.push(item);
            lastItem = item;
          }
        } else if (/^<DD/i.test(raw)) {
          if (lastItem) {
            lastItem.description = decodeEntities(match[5].trim());
          }
        }
      }
      return bookmarks;
    }

    function clientParseFirefoxJson(root) {
      const bookmarks = [];

      function walk(node, folderPath) {
        if (!node) return;
        const isBookmark = Boolean(node.uri || node.url) && (node.typeCode === 1 || node.type === 'text/x-moz-place' || !node.children);
        if (isBookmark) {
          const url = node.uri || node.url;
          if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
            const currentFolder = folderPath.length > 0 ? folderPath[folderPath.length - 1] : 'Unorganized';
            bookmarks.push({
              name: node.title || url,
              url: url,
              favIcon: node.iconuri || node.icon || null,
              folder: currentFolder,
              description: node.description || ''
            });
          }
          return;
        }
        const hasChildren = Array.isArray(node.children);
        const nextPath = [...folderPath];
        if (node.title && node.title !== 'root' && node.guid !== 'root________') {
          nextPath.push(node.title.trim());
        }
        if (hasChildren) {
          for (const child of node.children) {
            walk(child, nextPath);
          }
        }
      }

      walk(root, []);
      return bookmarks;
    }

    function parseFileBookmarks(text) {
      const trimmed = text.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const json = JSON.parse(trimmed);
          return clientParseFirefoxJson(json);
        } catch (_) {}
      }
      return clientParseFirefoxHtml(text);
    }

    const modal = document.getElementById('firefoxModal');
    const openModalBtn = document.getElementById('openFirefoxModalBtn');
    const closeModalBtn = document.getElementById('closeFirefoxModal');
    const cancelBtn = document.getElementById('ffCancelBtn');
    const changeFileBtn = document.getElementById('ffChangeFileBtn');
    const submitBtn = document.getElementById('ffSubmitBtn');
    const dropZone = document.getElementById('ffDropZone');
    const fileInput = document.getElementById('ffFileInput');

    const stepSelect = document.getElementById('ffStepSelect');
    const stepOptions = document.getElementById('ffStepOptions');
    const stepResult = document.getElementById('ffStepResult');

    function openModal() {
      parsedFfBookmarks = [];
      fileInput.value = '';
      stepSelect.style.display = 'block';
      stepOptions.style.display = 'none';
      stepResult.style.display = 'none';
      modal.classList.add('active');
    }

    function closeModal() {
      modal.classList.remove('active');
    }

    openModalBtn.addEventListener('click', openModal);
    closeModalBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    changeFileBtn.addEventListener('click', () => {
      stepOptions.style.display = 'none';
      stepSelect.style.display = 'block';
      fileInput.value = '';
    });

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleFile(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFile(e.target.files[0]);
      }
    });

    async function handleFile(file) {
      try {
        const text = await file.text();
        const bookmarks = parseFileBookmarks(text);

        if (!bookmarks || bookmarks.length === 0) {
          alert('Could not find any valid HTTP/HTTPS bookmarks in "' + file.name + '". Please make sure you selected a valid Firefox bookmarks.html or bookmarks-*.json file.');
          return;
        }

        parsedFfBookmarks = bookmarks;

        const folders = new Set();
        bookmarks.forEach(b => {
          if (b.folder && b.folder !== 'Unorganized') folders.add(b.folder);
        });
        const folderList = Array.from(folders);

        document.getElementById('ffFileInfo').textContent = '✓ ' + file.name + ' (' + bookmarks.length + ' bookmarks)';
        document.getElementById('ffFoldersInfo').textContent = folderList.length > 0
          ? 'Detected ' + folderList.length + ' folders: ' + folderList.slice(0, 4).join(', ') + (folderList.length > 4 ? ' +' + (folderList.length - 4) + ' more' : '')
          : 'All bookmarks will be placed in "Unorganized" collection';

        document.getElementById('ffFolderListPreview').textContent = folderList.length > 0
          ? folderList.length + ' folders detected'
          : 'no subfolders';

        submitBtn.textContent = 'Import ' + bookmarks.length + ' Bookmarks';

        stepSelect.style.display = 'none';
        stepOptions.style.display = 'block';
      } catch (err) {
        alert('Error reading bookmarks file: ' + err.message);
      }
    }

    submitBtn.addEventListener('click', async () => {
      if (parsedFfBookmarks.length === 0) return;

      const mode = document.querySelector('input[name="ffMode"]:checked').value;
      const collectionsMode = document.querySelector('input[name="ffCollections"]:checked').value;
      const targetColId = parseInt(document.getElementById('ffSingleCollectionSelect').value, 10) || 1;
      const skipDuplicates = document.getElementById('ffSkipDuplicates').checked;

      stepOptions.style.display = 'none';
      stepResult.style.display = 'block';
      const resultText = document.getElementById('ffResultText');
      const resultSpinner = document.getElementById('ffResultSpinner');
      resultSpinner.textContent = '⏳';
      resultText.style.color = '#cdd6f4';
      resultText.textContent = 'Importing ' + parsedFfBookmarks.length + ' bookmarks...';

      try {
        const res = await fetch('/api/v1/import/firefox', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ${API_TOKEN ? `'Authorization': 'Bearer ${API_TOKEN}'` : "'' : ''"}
          },
          body: JSON.stringify({
            items: parsedFfBookmarks,
            mode: mode,
            createCollections: collectionsMode === 'auto',
            targetCollectionId: targetColId,
            skipDuplicates: skipDuplicates
          })
        });

        const json = await res.json();
        if (res.ok) {
          resultSpinner.textContent = '🎉';
          resultText.style.color = '#a6e3a1';
          resultText.textContent = '✓ ' + (json.response || 'Bookmarks imported successfully!') + ' Reloading dashboard...';
          setTimeout(() => window.location.reload(), 1200);
        } else {
          resultSpinner.textContent = '❌';
          resultText.style.color = '#f38ba8';
          resultText.textContent = 'Error: ' + (json.response || 'Failed to import bookmarks');
          submitBtn.textContent = 'Retry';
          setTimeout(() => {
            stepResult.style.display = 'none';
            stepOptions.style.display = 'block';
          }, 2500);
        }
      } catch (err) {
        resultSpinner.textContent = '❌';
        resultText.style.color = '#f38ba8';
        resultText.textContent = 'Network or server error: ' + err.message;
        setTimeout(() => {
          stepResult.style.display = 'none';
          stepOptions.style.display = 'block';
        }, 2500);
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
    if (!body || (typeof body !== 'object' && typeof body !== 'string')) {
      return sendJson(res, 400, { response: 'Invalid payload for import' });
    }

    try {
      // Check if it's Firefox format (HTML or JSON)
      const isFirefoxJson = body && (body.guid || (body.type && String(body.type).includes('moz')) || (body.children && Array.isArray(body.children)));
      const isFirefoxHtml = typeof body === 'string' || (body && (body.html || body.content));

      if (isFirefoxJson) {
        const ffBookmarks = parseFirefoxJson(body);
        const stats = importFirefoxData({ bookmarks: ffBookmarks, mode: 'replace', createCollections: true });
        return sendJson(res, 200, {
          response: `Successfully imported ${stats.importedCount} bookmarks and ${stats.collectionsCreated} collections.`,
          status: 200,
          linksCount: stats.importedCount,
          collectionsCount: stats.collectionsCreated
        });
      }

      if (isFirefoxHtml && (typeof body === 'string' || body.html || (body.content && String(body.content).includes('<')))) {
        const htmlStr = typeof body === 'string' ? body : (body.html || body.content);
        const ffBookmarks = parseFirefoxHtml(htmlStr);
        if (ffBookmarks.length > 0) {
          const stats = importFirefoxData({ bookmarks: ffBookmarks, mode: 'replace', createCollections: true });
          return sendJson(res, 200, {
            response: `Successfully imported ${stats.importedCount} bookmarks and ${stats.collectionsCreated} collections.`,
            status: 200,
            linksCount: stats.importedCount,
            collectionsCount: stats.collectionsCreated
          });
        }
      }

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

  // 3b. Import Firefox bookmarks
  if (pathname === '/api/v1/import/firefox' && method === 'POST') {
    const body = await parseBody(req);
    const content = body.content || body.html || body.fileContent || body;
    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    const createCollections = body.createCollections !== false;
    const targetCollectionId = body.targetCollectionId || 1;
    const skipDuplicates = body.skipDuplicates !== false;

    let bookmarks = [];
    if (Array.isArray(body.items) || Array.isArray(body.bookmarks)) {
      bookmarks = body.items || body.bookmarks;
    } else {
      bookmarks = parseFirefoxBookmarks(content);
    }

    if (!bookmarks || bookmarks.length === 0) {
      return sendJson(res, 400, {
        response: 'No valid bookmarks found in uploaded file. Please make sure it is a valid Firefox bookmarks HTML or JSON file.',
        status: 400
      });
    }

    try {
      const stats = importFirefoxData({
        bookmarks,
        mode,
        createCollections,
        targetCollectionId,
        skipDuplicates
      });

      return sendJson(res, 200, {
        response: `Successfully imported ${stats.importedCount} bookmarks (${stats.collectionsCreated} new collections created, ${stats.skippedDuplicates} duplicates skipped).`,
        status: 200,
        ...stats
      });
    } catch (err) {
      console.error('[Mini-Linkwarden] Firefox import error:', err);
      return sendJson(res, 500, { response: `Import failed: ${err.message}`, status: 500 });
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

  // 7. Update Bookmark
  // PUT /api/v1/links/:id
  const putLinkMatch = pathname.match(/^\/api\/v1\/links\/(\d+)$/);
  if (putLinkMatch && method === 'PUT') {
    const id = parseInt(putLinkMatch[1], 10);
    const body = await parseBody(req);
    const link = db.links.find(l => l.id === id);

    if (!link) {
      return sendJson(res, 404, { response: 'Bookmark not found' });
    }

    if (body.url) {
      let targetUrl = String(body.url).trim();
      if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;
      link.url = targetUrl;
      try {
        const domain = new URL(targetUrl).hostname;
        link.favIcon = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
      } catch (_) {}
    }

    if (body.name !== undefined) {
      link.name = String(body.name).trim() || link.url;
    }

    if (body.description !== undefined) {
      link.description = String(body.description);
    }

    if (body.collectionId) {
      link.collectionId = parseInt(body.collectionId, 10);
    } else if (body.collection && body.collection.id) {
      link.collectionId = parseInt(body.collection.id, 10);
    }

    link.updatedAt = new Date().toISOString();
    saveDb();
    console.log(`[Mini-Linkwarden] Updated bookmark id ${id} ("${link.name}")`);
    return sendJson(res, 200, { response: link, status: 200 });
  }

  // 8. Delete Bookmark
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
