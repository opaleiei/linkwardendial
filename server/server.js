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
      if (body.length > 5 * 1024 * 1024) {
        req.destroy(); // Protect against massive payloads
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

  // 1. Health check & status
  if (pathname === '/' || pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'mini-linkwarden',
      version: '1.0.0',
      linksCount: db.links.length,
      collectionsCount: db.collections.length
    });
  }

  // 2. Collections endpoints
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

  // 3. Search / Links listing endpoints
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

  // 4. Create Bookmark
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
      // Auto-fetch title from web page
      const scrapedTitle = await fetchPageTitle(targetUrl);
      name = scrapedTitle || targetUrl;
    }

    let collectionId = body.collection && body.collection.id ? parseInt(body.collection.id, 10) : 1;
    // Verify collection exists, fallback to default
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

  // 5. Delete Bookmark
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
