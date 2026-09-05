const CONFIG_COLLECTION_NAME = '⚙️ Speed Dial Config';

let currentLinks = [];
let currentConfig = {
  version: 1,
  order: [],
  updatedAt: 0,
  openInNewTab: false,
  selectedCollectionId: null
};

let configCollection = null;
let configCollectionId = null;
let draggedCard = null;
let isDragging = false;
let saveDebounceTimer = null;
let statusTimeout = null;

function showSyncStatus(text, type = 'info', autoHide = true) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  if (statusTimeout) clearTimeout(statusTimeout);

  el.textContent = text;
  el.className = `sync-status ${type}`;
  el.classList.remove('hidden', 'fading');

  if (autoHide) {
    statusTimeout = setTimeout(() => {
      el.classList.add('fading');
      setTimeout(() => el.classList.add('hidden'), 400);
    }, 2500);
  }
}

function serializeConfig(config) {
  // Normalize order IDs (prefer number if integer, else string)
  const normalizedOrder = (config.order || []).map(id => {
    const num = Number(id);
    return !isNaN(num) && num.toString() === String(id) ? num : String(id);
  });

  let compact = {
    v: config.version || 1,
    order: normalizedOrder,
    t: config.updatedAt || Date.now(),
    newTab: Boolean(config.openInNewTab),
    colId: config.selectedCollectionId || null
  };

  let str = JSON.stringify(compact);
  // Linkwarden description max length is 2048 chars
  if (str.length <= 2040) {
    return str;
  }

  // Trim lowest items in custom order if exceeding 2040 chars
  while (str.length > 2040 && compact.order.length > 0) {
    compact.order.pop();
    str = JSON.stringify(compact);
  }
  return str;
}

function deserializeConfig(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      version: parsed.version || parsed.v || 1,
      order: parsed.order || parsed.o || [],
      updatedAt: parsed.updatedAt || parsed.t || 0,
      openInNewTab: parsed.openInNewTab ?? parsed.newTab ?? false,
      selectedCollectionId: parsed.selectedCollectionId || parsed.colId || null
    };
  } catch (e) {
    return null;
  }
}

async function fetchCollections(linkwardenUrl, apiToken) {
  try {
    const res = await fetch(`${linkwardenUrl}/api/v1/collections`, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      }
    });
    if (!res.ok) {
      console.warn(`fetchCollections returned HTTP ${res.status}`);
      return [];
    }
    const json = await res.json();
    return json.response || json.data || (Array.isArray(json) ? json : []);
  } catch (err) {
    console.warn('Failed to fetch collections:', err);
    return [];
  }
}

async function getOrCreateConfigCollection(linkwardenUrl, apiToken, collections = null) {
  if (configCollection && configCollection.id && configCollection.name) {
    return configCollection;
  }

  if (!collections || collections.length === 0) {
    collections = await fetchCollections(linkwardenUrl, apiToken);
  }

  let found = collections.find(c => 
    c.name === CONFIG_COLLECTION_NAME || 
    c.name.toLowerCase() === 'speed dial config' ||
    c.name.toLowerCase() === '⚙️ speed dial config'
  );

  if (found) {
    configCollection = found;
    configCollectionId = found.id;
    return found;
  }

  // Create config collection in Linkwarden
  try {
    const res = await fetch(`${linkwardenUrl}/api/v1/collections`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: CONFIG_COLLECTION_NAME,
        description: serializeConfig(currentConfig),
        color: '#89b4fa'
      })
    });

    if (res.ok) {
      const json = await res.json();
      const created = json.response || json.data || json;
      if (created && created.id) {
        configCollection = created;
        configCollectionId = created.id;
        return created;
      }
    } else {
      const errText = await res.text();
      console.error(`Linkwarden POST collection failed (${res.status}):`, errText);
    }
  } catch (err) {
    console.error('Could not create config collection in Linkwarden:', err);
  }

  return null;
}

async function loadConfigFromLinkwarden(linkwardenUrl, apiToken, collections) {
  const collection = await getOrCreateConfigCollection(linkwardenUrl, apiToken, collections);
  if (!collection || !collection.description) return null;
  return deserializeConfig(collection.description);
}

async function saveConfigToLinkwarden(linkwardenUrl, apiToken, config) {
  showSyncStatus('Saving to Linkwarden...', 'saving', false);
  try {
    let collection = await getOrCreateConfigCollection(linkwardenUrl, apiToken);

    if (!collection || !collection.id) {
      throw new Error('Config collection could not be found or created');
    }

    // Prepare members according to Linkwarden UpdateCollectionSchema:
    // members must be an array of { userId: number, canCreate: boolean, canUpdate: boolean, canDelete: boolean }
    const members = Array.isArray(collection.members)
      ? collection.members
          .filter(m => m && (m.userId || m.user?.id || m.id))
          .map(m => ({
            userId: Number(m.userId || m.user?.id || m.id),
            canCreate: Boolean(m.canCreate),
            canUpdate: Boolean(m.canUpdate),
            canDelete: Boolean(m.canDelete)
          }))
      : [];

    const payload = {
      id: Number(collection.id),
      name: String(collection.name || CONFIG_COLLECTION_NAME).trim(),
      description: serializeConfig(config),
      color: collection.color || '#89b4fa',
      members: members
    };

    const res = await fetch(`${linkwardenUrl}/api/v1/collections/${collection.id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Linkwarden PUT collection failed (${res.status}):`, errText);
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    try {
      const json = await res.json();
      if (json && json.response) {
        configCollection = { ...configCollection, ...json.response };
      }
    } catch (_) {}

    showSyncStatus('Synced to Linkwarden ✓', 'success', true);
  } catch (err) {
    console.error('Failed to save config to Linkwarden:', err);
    showSyncStatus('Saved locally (Linkwarden sync failed)', 'error', true);
  }
}

async function fetchAllBookmarks(linkwardenUrl, apiToken, selectedCollectionId = null) {
  let allLinks = [];
  let cursor = null;
  let hasMore = true;
  let pageCount = 0;
  const maxPages = 50;

  let endpoint = `${linkwardenUrl}/api/v1/search`;

  while (hasMore && pageCount < maxPages) {
    pageCount++;

    const params = new URLSearchParams();
    params.append('limit', '100');
    if (selectedCollectionId) {
      params.append('collectionId', selectedCollectionId);
    }
    if (cursor !== null && cursor !== undefined && cursor !== '') {
      params.append('cursor', cursor);
    }

    let response = await fetch(`${endpoint}?${params.toString()}`, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok && endpoint.endsWith('/search') && pageCount === 1) {
      endpoint = `${linkwardenUrl}/api/v1/links`;
      response = await fetch(`${endpoint}?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        }
      });
    }

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    const json = await response.json();

    let currentBatch = [];
    let nextCursor = null;

    if (json.data && Array.isArray(json.data.links)) {
      currentBatch = json.data.links;
      nextCursor = json.data.nextCursor;
    } else if (json.response && Array.isArray(json.response.links)) {
      currentBatch = json.response.links;
      nextCursor = json.response.nextCursor;
    } else if (Array.isArray(json.response)) {
      currentBatch = json.response;
      nextCursor = json.nextCursor ?? json.next_cursor;
    } else if (Array.isArray(json.data)) {
      currentBatch = json.data;
      nextCursor = json.nextCursor ?? json.next_cursor;
    } else if (Array.isArray(json)) {
      currentBatch = json;
    }

    if (!currentBatch || currentBatch.length === 0) {
      hasMore = false;
    } else {
      allLinks.push(...currentBatch);

      if (
        nextCursor !== null &&
        nextCursor !== undefined &&
        nextCursor !== '' &&
        nextCursor !== cursor
      ) {
        cursor = nextCursor;
      } else {
        hasMore = false;
      }
    }
  }

  // Exclude any link that might belong to the config collection itself
  const filteredLinks = allLinks.filter(link => {
    if (configCollectionId && link.collectionId === configCollectionId) return false;
    if (link.collection && (link.collection.name === CONFIG_COLLECTION_NAME || link.collection.id === configCollectionId)) {
      return false;
    }
    return true;
  });

  const seen = new Set();
  const uniqueLinks = [];
  for (const link of filteredLinks) {
    const key = String(link.id || link.url);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueLinks.push(link);
    }
  }

  return uniqueLinks;
}

function applyCustomOrder(links, order) {
  if (!order || !Array.isArray(order) || order.length === 0) {
    // Default sort: oldest first
    return links.slice().sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (dateA && dateB && dateA !== dateB) return dateA - dateB;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });
  }

  const map = new Map();
  for (const link of links) {
    map.set(String(link.id), link);
    if (link.url) map.set(link.url, link);
  }

  const ordered = [];
  const addedKeys = new Set();

  // 1. Add bookmarks in saved order
  for (const item of order) {
    const key = String(item);
    if (map.has(key)) {
      const link = map.get(key);
      const uniqueId = String(link.id || link.url);
      if (!addedKeys.has(uniqueId)) {
        ordered.push(link);
        addedKeys.add(uniqueId);
      }
    }
  }

  // 2. Append any new bookmarks that aren't yet in saved order
  const remaining = [];
  for (const link of links) {
    const uniqueId = String(link.id || link.url);
    if (!addedKeys.has(uniqueId)) {
      remaining.push(link);
      addedKeys.add(uniqueId);
    }
  }

  remaining.sort((a, b) => {
    const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (dateA && dateB && dateA !== dateB) return dateA - dateB;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });

  return [...ordered, ...remaining];
}

function renderGrid(links, openInNewTab = false) {
  const gridEl = document.getElementById('grid');
  const messageEl = document.getElementById('message');

  if (!links || links.length === 0) {
    gridEl.innerHTML = '';
    messageEl.textContent = 'No bookmarks found in Linkwarden.';
    messageEl.classList.remove('hidden');
    return;
  }

  messageEl.classList.add('hidden');
  gridEl.innerHTML = '';

  links.forEach(item => {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = item.url;
    card.draggable = true;
    card.dataset.id = String(item.id || item.url);
    card.title = item.name ? `${item.name}\n${item.url}` : item.url;

    if (openInNewTab) {
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
    }

    const icon = document.createElement('img');
    icon.className = 'icon';
    icon.alt = '';

    try {
      const domain = new URL(item.url).hostname;
      icon.src = item.favIcon || `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
    } catch (e) {
      icon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌐</text></svg>';
    }

    icon.onerror = () => {
      icon.onerror = null;
      icon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌐</text></svg>';
    };

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = item.name || item.url;

    card.appendChild(icon);
    card.appendChild(title);

    attachDragEvents(card);

    gridEl.appendChild(card);
  });
}

function attachDragEvents(card) {
  card.addEventListener('dragstart', (e) => {
    draggedCard = card;
    isDragging = true;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.id);
    setTimeout(() => {
      if (draggedCard === card) {
        card.classList.add('dragging');
      }
    }, 0);
  });

  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!draggedCard || draggedCard === card) return;

    const rect = card.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const isLeft = e.clientX < midX;

    card.classList.toggle('drag-over-left', isLeft);
    card.classList.toggle('drag-over-right', !isLeft);
  });

  card.addEventListener('dragleave', () => {
    card.classList.remove('drag-over-left', 'drag-over-right');
  });

  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drag-over-left', 'drag-over-right');
    if (!draggedCard || draggedCard === card) return;

    const gridEl = document.getElementById('grid');
    const rect = card.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const isLeft = e.clientX < midX;

    if (isLeft) {
      gridEl.insertBefore(draggedCard, card);
    } else {
      gridEl.insertBefore(draggedCard, card.nextSibling);
    }

    handleOrderRearranged();
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.card').forEach(c => {
      c.classList.remove('drag-over-left', 'drag-over-right');
    });
    draggedCard = null;
    setTimeout(() => {
      isDragging = false;
    }, 150);
  });

  card.addEventListener('click', (e) => {
    if (isDragging) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
  });
}

function handleOrderRearranged() {
  const gridEl = document.getElementById('grid');
  const cards = Array.from(gridEl.querySelectorAll('.card'));
  const newOrder = cards.map(c => c.dataset.id);

  currentConfig.order = newOrder;
  currentConfig.updatedAt = Date.now();

  // 1. Immediately persist to local storage for zero latency
  browser.storage.local.set({
    cachedSpeedDialConfig: currentConfig,
    cachedSpeedDialOrder: newOrder
  });

  // 2. Debounce sync to Linkwarden (avoids hammering API while user drags multiple items)
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(async () => {
    const { linkwardenUrl, apiToken, syncToLinkwarden } = await browser.storage.sync.get([
      'linkwardenUrl', 
      'apiToken',
      'syncToLinkwarden'
    ]);

    if (syncToLinkwarden === false) {
      showSyncStatus('Saved locally', 'info', true);
      return;
    }

    if (linkwardenUrl && apiToken) {
      await saveConfigToLinkwarden(linkwardenUrl, apiToken, currentConfig);
    }
  }, 600);
}

async function initSpeedDial() {
  const messageEl = document.getElementById('message');
  const settingsBtn = document.getElementById('settings-btn');

  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      browser.runtime.openOptionsPage();
    });
  }

  // 1. Check local cache for instant paint
  const localData = await browser.storage.local.get(['cachedLinks', 'cachedSpeedDialConfig', 'cachedSpeedDialOrder']);
  if (localData.cachedSpeedDialConfig) {
    currentConfig = { ...currentConfig, ...localData.cachedSpeedDialConfig };
  } else if (localData.cachedSpeedDialOrder) {
    currentConfig.order = localData.cachedSpeedDialOrder;
  }

  if (localData.cachedLinks && Array.isArray(localData.cachedLinks) && localData.cachedLinks.length > 0) {
    currentLinks = applyCustomOrder(localData.cachedLinks, currentConfig.order);
    renderGrid(currentLinks, currentConfig.openInNewTab);
    showSyncStatus('Checking Linkwarden...', 'info', false);
  }

  // 2. Fetch connection credentials
  const syncSettings = await browser.storage.sync.get(['linkwardenUrl', 'apiToken', 'selectedCollectionId', 'openInNewTab']);
  const { linkwardenUrl, apiToken, selectedCollectionId, openInNewTab } = syncSettings;

  if (openInNewTab !== undefined) {
    currentConfig.openInNewTab = Boolean(openInNewTab);
  }

  if (!linkwardenUrl || !apiToken) {
    if (!localData.cachedLinks || localData.cachedLinks.length === 0) {
      messageEl.innerHTML = 'Please configure your Linkwarden URL and API Token in the <a href="#" id="open-options">Extension Options</a>.';
      messageEl.classList.remove('hidden');
      document.getElementById('open-options')?.addEventListener('click', (e) => {
        e.preventDefault();
        browser.runtime.openOptionsPage();
      });
    }
    return;
  }

  // 3. Fetch remote collections and config from Linkwarden
  try {
    const collections = await fetchCollections(linkwardenUrl, apiToken);
    const remoteConfig = await loadConfigFromLinkwarden(linkwardenUrl, apiToken, collections);

    if (remoteConfig) {
      // Merge remote config if remote is newer or local is empty
      if (!currentConfig.updatedAt || (remoteConfig.updatedAt && remoteConfig.updatedAt >= currentConfig.updatedAt)) {
        currentConfig = { ...currentConfig, ...remoteConfig };
        if (remoteConfig.openInNewTab !== undefined) {
          currentConfig.openInNewTab = remoteConfig.openInNewTab;
        }
      }
    }

    // 4. Fetch links
    const targetCollectionId = selectedCollectionId || currentConfig.selectedCollectionId || null;
    const rawLinks = await fetchAllBookmarks(linkwardenUrl, apiToken, targetCollectionId);

    // Save to local cache
    await browser.storage.local.set({
      cachedLinks: rawLinks,
      cachedSpeedDialConfig: currentConfig,
      cachedSpeedDialOrder: currentConfig.order
    });

    // 5. Apply custom order and render
    currentLinks = applyCustomOrder(rawLinks, currentConfig.order);
    renderGrid(currentLinks, currentConfig.openInNewTab);

    showSyncStatus('Synced with Linkwarden ✓', 'success', true);
  } catch (err) {
    console.error('Error fetching from Linkwarden:', err);
    if (!localData.cachedLinks || localData.cachedLinks.length === 0) {
      messageEl.textContent = `Failed to fetch bookmarks: ${err.message}`;
      messageEl.classList.remove('hidden');
      showSyncStatus('Sync failed', 'error', true);
    } else {
      showSyncStatus('Offline (Showing cached)', 'info', true);
    }
  }
}

document.addEventListener('DOMContentLoaded', initSpeedDial);
