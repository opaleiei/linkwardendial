const CONFIG_COLLECTION_NAME = '⚙️ Speed Dial Config';
const DEFAULT_BG_COLOR = '#11111b';

let uploadedImageData = null;
let shouldClearBgImage = false;

function showStatus(text, type = 'success') {
  const status = document.getElementById('status');
  status.textContent = text;
  status.className = type;
  status.style.display = 'block';
  if (type === 'success') {
    setTimeout(() => {
      status.style.display = 'none';
    }, 3500);
  }
}

async function loadCollections(linkwardenUrl, apiToken, currentSelectedId = null) {
  const select = document.getElementById('collectionSelect');
  select.innerHTML = '<option value="">All Bookmarks (Default)</option>';

  try {
    const res = await fetch(`${linkwardenUrl}/api/v1/collections`, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}` };
    }

    const json = await res.json();
    const collections = json.response || json.data || (Array.isArray(json) ? json : []);

    let configCollection = null;

    collections.forEach(col => {
      if (
        col.name === CONFIG_COLLECTION_NAME || 
        col.name.toLowerCase() === 'speed dial config' ||
        col.name.toLowerCase() === '⚙️ speed dial config'
      ) {
        configCollection = col;
        return; // Don't add config collection itself as a bookmark choice
      }

      const opt = document.createElement('option');
      opt.value = String(col.id);
      opt.textContent = col.name;
      if (currentSelectedId && String(col.id) === String(currentSelectedId)) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });

    return { success: true, count: collections.length, configCollection };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Load sync settings
  const syncData = await browser.storage.sync.get([
    'linkwardenUrl',
    'apiToken',
    'selectedCollectionId',
    'openInNewTab',
    'syncToLinkwarden',
    'backgroundColor',
    'bgImageUrl'
  ]);

  // Load local settings (especially uploaded background image)
  const localData = await browser.storage.local.get([
    'backgroundColor',
    'bgImageUrl',
    'bgImageData'
  ]);

  if (syncData.linkwardenUrl) document.getElementById('serverUrl').value = syncData.linkwardenUrl;
  if (syncData.apiToken) document.getElementById('apiToken').value = syncData.apiToken;
  if (syncData.openInNewTab !== undefined) document.getElementById('openInNewTab').checked = syncData.openInNewTab;
  if (syncData.syncToLinkwarden !== undefined) {
    document.getElementById('syncToLinkwarden').checked = syncData.syncToLinkwarden;
  }

  // Appearance & Background
  const savedBgColor = localData.backgroundColor || syncData.backgroundColor || DEFAULT_BG_COLOR;
  document.getElementById('bgColorPicker').value = savedBgColor;
  document.getElementById('bgColorText').value = savedBgColor;

  const savedBgUrl = localData.bgImageUrl || syncData.bgImageUrl || '';
  document.getElementById('bgImageUrl').value = savedBgUrl;

  const clearBtnRow = document.getElementById('clearBgImageRow');
  const fileStatus = document.getElementById('bgImageFileStatus');

  if (localData.bgImageData) {
    uploadedImageData = localData.bgImageData;
    fileStatus.textContent = '✓ Custom uploaded image is active';
    clearBtnRow.style.display = 'block';
  } else if (savedBgUrl) {
    clearBtnRow.style.display = 'block';
  }

  if (syncData.linkwardenUrl && syncData.apiToken) {
    await loadCollections(syncData.linkwardenUrl, syncData.apiToken, syncData.selectedCollectionId);
  }
});

// Color picker & text input synchronization
const bgColorPicker = document.getElementById('bgColorPicker');
const bgColorText = document.getElementById('bgColorText');

bgColorPicker.addEventListener('input', () => {
  bgColorText.value = bgColorPicker.value;
});

bgColorText.addEventListener('input', () => {
  const val = bgColorText.value.trim();
  if (/^#([0-9A-Fa-f]{3}){1,2}$/.test(val)) {
    bgColorPicker.value = val;
  }
});

document.getElementById('resetBgColor').addEventListener('click', () => {
  bgColorPicker.value = DEFAULT_BG_COLOR;
  bgColorText.value = DEFAULT_BG_COLOR;
});

// Background image file upload
document.getElementById('bgImageFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > 8 * 1024 * 1024) {
    showStatus('Image file is too large (max 8MB).', 'error');
    e.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    uploadedImageData = reader.result;
    shouldClearBgImage = false;
    document.getElementById('bgImageFileStatus').textContent = `✓ Loaded "${file.name}" (${Math.round(file.size / 1024)} KB)`;
    document.getElementById('clearBgImageRow').style.display = 'block';
  };
  reader.readAsDataURL(file);
});

// Remove background image
document.getElementById('clearBgImage').addEventListener('click', () => {
  uploadedImageData = null;
  shouldClearBgImage = true;
  document.getElementById('bgImageUrl').value = '';
  document.getElementById('bgImageFile').value = '';
  document.getElementById('bgImageFileStatus').textContent = '';
  document.getElementById('clearBgImageRow').style.display = 'none';
});

document.getElementById('bgImageUrl').addEventListener('input', () => {
  const url = document.getElementById('bgImageUrl').value.trim();
  const clearBtnRow = document.getElementById('clearBgImageRow');
  if (url || uploadedImageData) {
    clearBtnRow.style.display = 'block';
  } else {
    clearBtnRow.style.display = 'none';
  }
});

document.getElementById('test-connection').addEventListener('click', async () => {
  let url = document.getElementById('serverUrl').value.trim();
  const token = document.getElementById('apiToken').value.trim();

  if (!url || !token) {
    showStatus('Please enter both the Server URL and API Token.', 'error');
    return;
  }

  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }

  showStatus('Testing connection to Linkwarden...', 'info');

  const selectedCol = document.getElementById('collectionSelect').value;
  const result = await loadCollections(url, token, selectedCol);

  if (result.success) {
    const configMsg = result.configCollection 
      ? 'Config collection found.' 
      : 'Config collection will be created automatically on next save.';
    showStatus(`Connection successful! Loaded ${result.count} collections. ${configMsg}`, 'success');
  } else {
    showStatus(`Connection failed: ${result.error}`, 'error');
  }
});

document.getElementById('save').addEventListener('click', async () => {
  let url = document.getElementById('serverUrl').value.trim();
  const token = document.getElementById('apiToken').value.trim();
  const selectedCollectionId = document.getElementById('collectionSelect').value || null;
  const openInNewTab = document.getElementById('openInNewTab').checked;
  const syncToLinkwarden = document.getElementById('syncToLinkwarden').checked;

  const bgColor = document.getElementById('bgColorText').value.trim() || document.getElementById('bgColorPicker').value || DEFAULT_BG_COLOR;
  const bgImageUrl = document.getElementById('bgImageUrl').value.trim();

  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }

  // 1. Save general settings to sync
  await browser.storage.sync.set({
    linkwardenUrl: url,
    apiToken: token,
    selectedCollectionId,
    openInNewTab,
    syncToLinkwarden,
    backgroundColor: bgColor,
    bgImageUrl: bgImageUrl
  });

  // 2. Save background to local storage (safe for large image data URLs)
  const localUpdates = {
    backgroundColor: bgColor,
    bgImageUrl: bgImageUrl
  };

  if (shouldClearBgImage) {
    await browser.storage.local.remove(['bgImageData', 'bgImageUrl']);
    shouldClearBgImage = false;
  } else if (uploadedImageData) {
    localUpdates.bgImageData = uploadedImageData;
  }

  await browser.storage.local.set(localUpdates);

  // Clear cached bookmarks so next tab open will fetch fresh data with any new collection filter
  await browser.storage.local.remove(['cachedLinks']);

  // Ensure config collection exists in Linkwarden if sync is enabled
  if (syncToLinkwarden && url && token) {
    try {
      const collectionsRes = await fetch(`${url}/api/v1/collections`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      if (collectionsRes.ok) {
        const json = await collectionsRes.json();
        const collections = json.response || json.data || (Array.isArray(json) ? json : []);
        const found = collections.find(c => 
          c.name === CONFIG_COLLECTION_NAME || 
          c.name.toLowerCase() === 'speed dial config' ||
          c.name.toLowerCase() === '⚙️ speed dial config'
        );
        if (!found) {
          await fetch(`${url}/api/v1/collections`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: CONFIG_COLLECTION_NAME,
              description: JSON.stringify({ v: 1, order: [], t: Date.now() }),
              color: '#89b4fa'
            })
          });
        }
      }
    } catch (e) {
      console.warn('Failed to ensure config collection during save:', e);
    }
  }

  showStatus('Settings saved successfully!', 'success');
});

document.getElementById('reset-order').addEventListener('click', async () => {
  if (!confirm('Are you sure you want to reset your bookmark dial order to the default chronological order?')) {
    return;
  }

  // 1. Reset in local storage
  await browser.storage.local.remove(['cachedSpeedDialOrder']);
  const localConfig = await browser.storage.local.get(['cachedSpeedDialConfig']);
  if (localConfig.cachedSpeedDialConfig) {
    localConfig.cachedSpeedDialConfig.order = [];
    localConfig.cachedSpeedDialConfig.updatedAt = Date.now();
    await browser.storage.local.set({ cachedSpeedDialConfig: localConfig.cachedSpeedDialConfig });
  }

  // 2. Reset in Linkwarden if connected
  const { linkwardenUrl, apiToken } = await browser.storage.sync.get(['linkwardenUrl', 'apiToken']);
  if (linkwardenUrl && apiToken) {
    try {
      const res = await fetch(`${linkwardenUrl}/api/v1/collections`, {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        }
      });
      if (res.ok) {
        const json = await res.json();
        const collections = json.response || json.data || (Array.isArray(json) ? json : []);
        const found = collections.find(c => 
          c.name === CONFIG_COLLECTION_NAME || 
          c.name.toLowerCase() === 'speed dial config' ||
          c.name.toLowerCase() === '⚙️ speed dial config'
        );
        if (found) {
          const members = Array.isArray(found.members)
            ? found.members
                .filter(m => m && (m.userId || m.user?.id || m.id))
                .map(m => ({
                  userId: Number(m.userId || m.user?.id || m.id),
                  canCreate: Boolean(m.canCreate),
                  canUpdate: Boolean(m.canUpdate),
                  canDelete: Boolean(m.canDelete)
                }))
            : [];

          const updatedConfig = { v: 1, order: [], t: Date.now() };
          await fetch(`${linkwardenUrl}/api/v1/collections/${found.id}`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${apiToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              id: Number(found.id),
              name: String(found.name || CONFIG_COLLECTION_NAME).trim(),
              description: JSON.stringify(updatedConfig),
              color: found.color || '#89b4fa',
              members: members
            })
          });
        }
      }
    } catch (e) {
      console.warn('Failed to reset order in Linkwarden:', e);
    }
  }

  showStatus('Dial order has been reset to default!', 'success');
});
