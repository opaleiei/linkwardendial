const CONFIG_COLLECTION_NAME = '⚙️ Speed Dial Config';

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
  const data = await browser.storage.sync.get([
    'linkwardenUrl',
    'apiToken',
    'selectedCollectionId',
    'openInNewTab',
    'syncToLinkwarden'
  ]);

  if (data.linkwardenUrl) document.getElementById('serverUrl').value = data.linkwardenUrl;
  if (data.apiToken) document.getElementById('apiToken').value = data.apiToken;
  if (data.openInNewTab !== undefined) document.getElementById('openInNewTab').checked = data.openInNewTab;
  if (data.syncToLinkwarden !== undefined) {
    document.getElementById('syncToLinkwarden').checked = data.syncToLinkwarden;
  }

  if (data.linkwardenUrl && data.apiToken) {
    await loadCollections(data.linkwardenUrl, data.apiToken, data.selectedCollectionId);
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

  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }

  await browser.storage.sync.set({
    linkwardenUrl: url,
    apiToken: token,
    selectedCollectionId,
    openInNewTab,
    syncToLinkwarden
  });

  // Clear cached bookmarks so next tab open will fetch fresh data with any new collection filter
  await browser.storage.local.remove(['cachedLinks']);

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
          const updatedConfig = { version: 1, order: [], updatedAt: Date.now() };
          await fetch(`${linkwardenUrl}/api/v1/collections/${found.id}`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${apiToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: found.name || CONFIG_COLLECTION_NAME,
              description: JSON.stringify(updatedConfig),
              color: found.color || '#89b4fa'
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
