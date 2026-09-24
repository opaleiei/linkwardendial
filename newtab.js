const CONFIG_COLLECTION_NAME = '⚙️ Speed Dial Config';

let currentLinks = [];
let currentCollections = [];
let currentConfig = {
  version: 1,
  order: [],
  updatedAt: 0,
  openInNewTab: false,
  selectedCollectionId: null,
  dialSize: 'medium',
  maxColumns: 'unlimited',
  defaultSort: 'newest_last'
};

let configCollection = null;
let configCollectionId = null;
let draggedCard = null;
let isDragging = false;
let saveDebounceTimer = null;
let statusTimeout = null;

// Map of id/url -> bookmark item for O(1) lookups during delegated events
const itemMap = new Map();

// Single shared dropdown in document.body
let sharedMenu = null;
let activeMenuItem = null;
let activeMenuCard = null;

// Apply custom background color / image immediately
async function applyBackground() {
  try {
    const data = await browser.storage.local.get(['backgroundColor', 'bgImageUrl', 'bgImageData']);
    if (data.backgroundColor) {
      document.body.style.backgroundColor = data.backgroundColor;
    }
    if (data.bgImageData) {
      document.body.style.backgroundImage = `url("${data.bgImageData}")`;
    } else if (data.bgImageUrl) {
      document.body.style.backgroundImage = `url("${data.bgImageUrl}")`;
    } else {
      document.body.style.backgroundImage = 'none';
    }
  } catch (err) {
    console.warn('Failed to load background settings:', err);
  }
}

applyBackground();

// Apply layout styles (dial size, max columns)
function applyLayoutSettings(dialSize = 'medium', maxColumns = 'unlimited') {
  document.body.classList.remove('size-small', 'size-medium', 'size-large');
  document.body.classList.add(`size-${dialSize || 'medium'}`);

  const gridEl = document.getElementById('grid');
  if (gridEl) {
    // Remove existing column classes
    gridEl.className = gridEl.className.replace(/\bcols-\S+/g, '').trim();
    const colClass = (maxColumns && maxColumns !== 'unlimited') ? `cols-${maxColumns}` : 'cols-unlimited';
    gridEl.classList.add(colClass);
  }
}

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
  const normalizedOrder = (config.order || []).map(id => {
    const num = Number(id);
    return !isNaN(num) && num.toString() === String(id) ? num : String(id);
  });

  let compact = {
    v: config.version || 1,
    order: normalizedOrder,
    t: config.updatedAt || Date.now(),
    newTab: Boolean(config.openInNewTab),
    colId: config.selectedCollectionId || null,
    dialSize: config.dialSize || 'medium',
    maxColumns: config.maxColumns || 'unlimited',
    defaultSort: config.defaultSort || 'newest_last'
  };

  let str = JSON.stringify(compact);
  if (str.length <= 2040) {
    return str;
  }

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
      selectedCollectionId: parsed.selectedCollectionId || parsed.colId || null,
      dialSize: parsed.dialSize || 'medium',
      maxColumns: parsed.maxColumns || 'unlimited',
      defaultSort: parsed.defaultSort || 'newest_last'
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

function applyCustomOrder(links, order, defaultSort = 'newest_last') {
  const isNewestFirst = defaultSort === 'newest_first';

  const defaultSortComparator = (a, b) => {
    const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (dateA && dateB && dateA !== dateB) {
      return isNewestFirst ? dateB - dateA : dateA - dateB;
    }
    const idA = Number(a.id) || 0;
    const idB = Number(b.id) || 0;
    return isNewestFirst ? idB - idA : idA - idB;
  };

  if (!order || !Array.isArray(order) || order.length === 0) {
    return links.slice().sort(defaultSortComparator);
  }

  const map = new Map();
  for (const link of links) {
    map.set(String(link.id), link);
    if (link.url) map.set(link.url, link);
  }

  const ordered = [];
  const addedKeys = new Set();

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

  const remaining = [];
  for (const link of links) {
    const uniqueId = String(link.id || link.url);
    if (!addedKeys.has(uniqueId)) {
      remaining.push(link);
      addedKeys.add(uniqueId);
    }
  }

  remaining.sort(defaultSortComparator);

  // If newest dials first is preferred, new unarranged bookmarks appear at the top!
  return isNewestFirst ? [...remaining, ...ordered] : [...ordered, ...remaining];
}

// ── Single Shared Dropdown Implementation ──
function getOrCreateSharedMenu() {
  if (sharedMenu) return sharedMenu;

  sharedMenu = document.createElement('div');
  sharedMenu.className = 'card-dropdown';
  sharedMenu.innerHTML = `
    <button class="card-dropdown-item danger" type="button">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        <line x1="10" y1="11" x2="10" y2="17"></line>
        <line x1="14" y1="11" x2="14" y2="17"></line>
      </svg>
      <span>Delete bookmark</span>
    </button>
  `;

  sharedMenu.querySelector('.card-dropdown-item.danger').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const item = activeMenuItem;
    const card = activeMenuCard;
    closeSharedMenu();
    if (item && card) {
      confirmDeleteBookmark(item, card);
    }
  });

  document.body.appendChild(sharedMenu);
  return sharedMenu;
}

function openSharedMenu(buttonEl, item, cardEl) {
  const menu = getOrCreateSharedMenu();

  if (activeMenuCard === cardEl && menu.classList.contains('open')) {
    closeSharedMenu();
    return;
  }

  activeMenuItem = item;
  activeMenuCard = cardEl;

  const rect = buttonEl.getBoundingClientRect();
  const top = Math.max(10, rect.top - 42);
  const left = Math.max(10, rect.right - 145);

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.classList.add('open');
}

function closeSharedMenu() {
  if (sharedMenu) {
    sharedMenu.classList.remove('open');
  }
  activeMenuItem = null;
  activeMenuCard = null;
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.card-menu-btn') && !e.target.closest('.card-dropdown')) {
    closeSharedMenu();
  }
});

window.addEventListener('scroll', closeSharedMenu, { passive: true });

function confirmDeleteBookmark(item, cardEl) {
  document.querySelector('.delete-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'delete-overlay';

  const name = item.name || item.url;
  overlay.innerHTML = `
    <div class="delete-dialog">
      <h3>Delete Bookmark</h3>
      <p>Are you sure you want to delete <strong id="delete-name"></strong> from Linkwarden? This action cannot be undone.</p>
      <div class="dialog-btns">
        <button class="btn-cancel" type="button">Cancel</button>
        <button class="btn-delete" type="button">Delete</button>
      </div>
    </div>
  `;

  overlay.querySelector('#delete-name').textContent = name;

  overlay.querySelector('.btn-cancel').addEventListener('click', () => {
    overlay.remove();
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay.querySelector('.btn-delete').addEventListener('click', async () => {
    overlay.remove();
    await executeDeleteBookmark(item, cardEl);
  });

  document.body.appendChild(overlay);
}

async function executeDeleteBookmark(item, cardEl) {
  showSyncStatus('Deleting bookmark from Linkwarden...', 'saving', false);

  const { linkwardenUrl, apiToken } = await browser.storage.sync.get(['linkwardenUrl', 'apiToken']);
  if (!linkwardenUrl || !apiToken) {
    showSyncStatus('Failed: Credentials not configured', 'error', true);
    return;
  }

  const linkId = item.id;
  if (!linkId) {
    showSyncStatus('Failed: Bookmark ID not found', 'error', true);
    return;
  }

  try {
    const res = await fetch(`${linkwardenUrl}/api/v1/links/${linkId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    cardEl.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    cardEl.style.opacity = '0';
    cardEl.style.transform = 'scale(0.8)';
    setTimeout(() => {
      cardEl.remove();
      const gridEl = document.getElementById('grid');
      if (!gridEl || gridEl.children.length === 0) {
        const messageEl = document.getElementById('message');
        messageEl.textContent = 'No bookmarks found in Linkwarden.';
        messageEl.classList.remove('hidden');
      }
    }, 200);

    const key = String(item.id || item.url);
    itemMap.delete(key);
    currentLinks = currentLinks.filter(l => String(l.id || l.url) !== key);

    currentConfig.order = currentConfig.order.filter(id => String(id) !== String(item.id) && String(id) !== String(item.url));
    currentConfig.updatedAt = Date.now();

    const localData = await browser.storage.local.get(['cachedLinks']);
    if (Array.isArray(localData.cachedLinks)) {
      const updatedCache = localData.cachedLinks.filter(l => String(l.id || l.url) !== key);
      await browser.storage.local.set({
        cachedLinks: updatedCache,
        cachedSpeedDialConfig: currentConfig,
        cachedSpeedDialOrder: currentConfig.order
      });
    }

    await saveConfigToLinkwarden(linkwardenUrl, apiToken, currentConfig);

    showSyncStatus('Bookmark deleted from Linkwarden ✓', 'success', true);
  } catch (err) {
    console.error('Failed to delete bookmark:', err);
    showSyncStatus(`Failed to delete bookmark (${err.message})`, 'error', true);
  }
}

// ── Add Bookmark Modal Handling ──
function setupAddBookmarkModal() {
  const modal = document.getElementById('add-modal');
  const addBtn = document.getElementById('add-bookmark-btn');
  const closeBtn = document.getElementById('add-modal-close');
  const cancelBtn = document.getElementById('add-modal-cancel');
  const form = document.getElementById('add-bookmark-form');
  const collectionSelect = document.getElementById('bm-collection');

  if (!modal || !addBtn || !form) return;

  function openAddModal() {
    closeSharedMenu();
    // Populate collections
    collectionSelect.innerHTML = '<option value="">Default (Unorganized)</option>';
    currentCollections.forEach(col => {
      if (
        col.name === CONFIG_COLLECTION_NAME || 
        col.name.toLowerCase() === 'speed dial config' ||
        col.name.toLowerCase() === '⚙️ speed dial config'
      ) return;

      const opt = document.createElement('option');
      opt.value = String(col.id);
      opt.textContent = col.name;
      if (currentConfig.selectedCollectionId && String(col.id) === String(currentConfig.selectedCollectionId)) {
        opt.selected = true;
      }
      collectionSelect.appendChild(opt);
    });

    document.getElementById('bm-url').value = '';
    document.getElementById('bm-name').value = '';
    modal.classList.remove('hidden');
    setTimeout(() => document.getElementById('bm-url').focus(), 50);
  }

  function closeAddModal() {
    modal.classList.add('hidden');
  }

  addBtn.addEventListener('click', openAddModal);
  closeBtn.addEventListener('click', closeAddModal);
  cancelBtn.addEventListener('click', closeAddModal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeAddModal();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    let url = document.getElementById('bm-url').value.trim();
    const name = document.getElementById('bm-name').value.trim();
    const collectionId = collectionSelect.value ? Number(collectionSelect.value) : undefined;

    if (!url) return;

    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }

    const { linkwardenUrl, apiToken } = await browser.storage.sync.get(['linkwardenUrl', 'apiToken']);
    if (!linkwardenUrl || !apiToken) {
      showSyncStatus('Please configure Linkwarden credentials first', 'error', true);
      closeAddModal();
      return;
    }

    showSyncStatus('Adding bookmark to Linkwarden...', 'saving', false);
    closeAddModal();

    try {
      const payload = {
        type: 'url',
        url: url,
        name: name || undefined,
        collection: collectionId ? { id: collectionId } : undefined
      };

      const res = await fetch(`${linkwardenUrl}/api/v1/links`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }

      const json = await res.json();
      const createdLink = json.response || json.data || json;

      if (!createdLink || !createdLink.id) {
        throw new Error('Invalid response from server');
      }

      // Add to in-memory links if viewing all or viewing matching collection
      const viewingCol = currentConfig.selectedCollectionId;
      const matchesCol = !viewingCol || (createdLink.collectionId && String(createdLink.collectionId) === String(viewingCol));

      if (matchesCol) {
        // Place according to defaultSort
        if (currentConfig.defaultSort === 'newest_first') {
          currentLinks.unshift(createdLink);
          currentConfig.order.unshift(createdLink.id);
        } else {
          currentLinks.push(createdLink);
          currentConfig.order.push(createdLink.id);
        }
        currentConfig.updatedAt = Date.now();

        // Update local cache
        await browser.storage.local.set({
          cachedLinks: currentLinks,
          cachedSpeedDialConfig: currentConfig,
          cachedSpeedDialOrder: currentConfig.order
        });

        // Persist order to Linkwarden
        await saveConfigToLinkwarden(linkwardenUrl, apiToken, currentConfig);

        // Re-render
        renderGrid(currentLinks, currentConfig.openInNewTab);
      }

      showSyncStatus('Bookmark added to Linkwarden ✓', 'success', true);
    } catch (err) {
      console.error('Failed to add bookmark:', err);
      showSyncStatus(`Failed to add bookmark (${err.message})`, 'error', true);
    }
  });
}

// ── Optimized DOM Rendering with DocumentFragment & Lazy Favicons ──
function renderGrid(links, openInNewTab = false) {
  const gridEl = document.getElementById('grid');
  const messageEl = document.getElementById('message');

  closeSharedMenu();
  itemMap.clear();

  if (!links || links.length === 0) {
    gridEl.replaceChildren();
    messageEl.textContent = 'No bookmarks found in Linkwarden.';
    messageEl.classList.remove('hidden');
    return;
  }

  messageEl.classList.add('hidden');
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < links.length; i++) {
    const item = links[i];
    const idKey = String(item.id || item.url);
    itemMap.set(idKey, item);

    const card = document.createElement('a');
    card.className = 'card';
    card.href = item.url;
    card.draggable = true;
    card.dataset.id = idKey;
    card.title = item.name ? `${item.name}\n${item.url}` : item.url;

    if (openInNewTab) {
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
    }

    const icon = document.createElement('img');
    icon.className = 'icon';
    icon.alt = '';
    icon.loading = 'lazy';

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

    const menuBtn = document.createElement('button');
    menuBtn.className = 'card-menu-btn';
    menuBtn.type = 'button';
    menuBtn.title = 'Bookmark options';
    menuBtn.setAttribute('aria-label', 'Bookmark options');
    menuBtn.textContent = '⋮';

    card.appendChild(icon);
    card.appendChild(title);
    card.appendChild(menuBtn);

    fragment.appendChild(card);
  }

  gridEl.replaceChildren(fragment);
}

// ── Event Delegation for Grid (Zero per-card listeners) ──
function setupGridDelegation() {
  const gridEl = document.getElementById('grid');
  if (!gridEl || gridEl.dataset.delegated) return;
  gridEl.dataset.delegated = 'true';

  gridEl.addEventListener('dragstart', (e) => {
    if (e.target.closest('.card-menu-btn')) {
      e.preventDefault();
      return;
    }
    closeSharedMenu();

    const card = e.target.closest('.card');
    if (!card) return;

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

  gridEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!draggedCard) return;

    const card = e.target.closest('.card');
    if (!card || card === draggedCard) return;

    const rect = card.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const isLeft = e.clientX < midX;

    card.classList.toggle('drag-over-left', isLeft);
    card.classList.toggle('drag-over-right', !isLeft);
  });

  gridEl.addEventListener('dragleave', (e) => {
    const card = e.target.closest('.card');
    if (card) {
      card.classList.remove('drag-over-left', 'drag-over-right');
    }
  });

  gridEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!draggedCard) return;

    const card = e.target.closest('.card');
    if (card) {
      card.classList.remove('drag-over-left', 'drag-over-right');
      if (card !== draggedCard) {
        const rect = card.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        const isLeft = e.clientX < midX;

        if (isLeft) {
          gridEl.insertBefore(draggedCard, card);
        } else {
          gridEl.insertBefore(draggedCard, card.nextSibling);
        }

        handleOrderRearranged();
      }
    }
  });

  gridEl.addEventListener('dragend', () => {
    if (draggedCard) {
      draggedCard.classList.remove('dragging');
    }
    const indicators = gridEl.querySelectorAll('.drag-over-left, .drag-over-right');
    for (let i = 0; i < indicators.length; i++) {
      indicators[i].classList.remove('drag-over-left', 'drag-over-right');
    }
    draggedCard = null;
    setTimeout(() => {
      isDragging = false;
    }, 150);
  });

  gridEl.addEventListener('click', (e) => {
    const menuBtn = e.target.closest('.card-menu-btn');
    if (menuBtn) {
      e.preventDefault();
      e.stopPropagation();
      const card = menuBtn.closest('.card');
      if (card) {
        const item = itemMap.get(card.dataset.id);
        if (item) {
          openSharedMenu(menuBtn, item, card);
        }
      }
      return false;
    }

    const card = e.target.closest('.card');
    if (!card) return;

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

  browser.storage.local.set({
    cachedSpeedDialConfig: currentConfig,
    cachedSpeedDialOrder: newOrder
  });

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

  setupGridDelegation();
  setupAddBookmarkModal();

  // 1. Check local cache for instant paint
  const localData = await browser.storage.local.get([
    'cachedLinks',
    'cachedSpeedDialConfig',
    'cachedSpeedDialOrder',
    'dialSize',
    'maxColumns',
    'defaultSort'
  ]);

  if (localData.cachedSpeedDialConfig) {
    currentConfig = { ...currentConfig, ...localData.cachedSpeedDialConfig };
  } else if (localData.cachedSpeedDialOrder) {
    currentConfig.order = localData.cachedSpeedDialOrder;
  }

  if (localData.dialSize) currentConfig.dialSize = localData.dialSize;
  if (localData.maxColumns) currentConfig.maxColumns = localData.maxColumns;
  if (localData.defaultSort) currentConfig.defaultSort = localData.defaultSort;

  applyLayoutSettings(currentConfig.dialSize, currentConfig.maxColumns);

  if (localData.cachedLinks && Array.isArray(localData.cachedLinks) && localData.cachedLinks.length > 0) {
    currentLinks = applyCustomOrder(localData.cachedLinks, currentConfig.order, currentConfig.defaultSort);
    renderGrid(currentLinks, currentConfig.openInNewTab);
    showSyncStatus('Checking Linkwarden...', 'info', false);
  }

  // 2. Fetch connection credentials & sync preferences
  const syncSettings = await browser.storage.sync.get([
    'linkwardenUrl',
    'apiToken',
    'selectedCollectionId',
    'openInNewTab',
    'dialSize',
    'maxColumns',
    'defaultSort'
  ]);

  const { linkwardenUrl, apiToken, selectedCollectionId, openInNewTab, dialSize, maxColumns, defaultSort } = syncSettings;

  if (openInNewTab !== undefined) currentConfig.openInNewTab = Boolean(openInNewTab);
  if (dialSize) currentConfig.dialSize = dialSize;
  if (maxColumns) currentConfig.maxColumns = maxColumns;
  if (defaultSort) currentConfig.defaultSort = defaultSort;

  applyLayoutSettings(currentConfig.dialSize, currentConfig.maxColumns);

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
    currentCollections = await fetchCollections(linkwardenUrl, apiToken);
    const remoteConfig = await loadConfigFromLinkwarden(linkwardenUrl, apiToken, currentCollections);

    if (remoteConfig) {
      if (!currentConfig.updatedAt || (remoteConfig.updatedAt && remoteConfig.updatedAt >= currentConfig.updatedAt)) {
        currentConfig = { ...currentConfig, ...remoteConfig };
        if (remoteConfig.openInNewTab !== undefined) {
          currentConfig.openInNewTab = remoteConfig.openInNewTab;
        }
        if (remoteConfig.dialSize) currentConfig.dialSize = remoteConfig.dialSize;
        if (remoteConfig.maxColumns) currentConfig.maxColumns = remoteConfig.maxColumns;
        if (remoteConfig.defaultSort) currentConfig.defaultSort = remoteConfig.defaultSort;
      }
    }

    applyLayoutSettings(currentConfig.dialSize, currentConfig.maxColumns);

    // 4. Fetch links
    const targetCollectionId = selectedCollectionId || currentConfig.selectedCollectionId || null;
    const rawLinks = await fetchAllBookmarks(linkwardenUrl, apiToken, targetCollectionId);

    // Save to local cache
    await browser.storage.local.set({
      cachedLinks: rawLinks,
      cachedSpeedDialConfig: currentConfig,
      cachedSpeedDialOrder: currentConfig.order,
      dialSize: currentConfig.dialSize,
      maxColumns: currentConfig.maxColumns,
      defaultSort: currentConfig.defaultSort
    });

    // 5. Apply custom order and render
    currentLinks = applyCustomOrder(rawLinks, currentConfig.order, currentConfig.defaultSort);
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
