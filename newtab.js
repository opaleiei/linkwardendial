async function fetchLinkwardenBookmarks() {
  const messageEl = document.getElementById('message');
  const gridEl = document.getElementById('grid');

  const { linkwardenUrl, apiToken } = await browser.storage.sync.get(['linkwardenUrl', 'apiToken']);

  if (!linkwardenUrl || !apiToken) {
    messageEl.innerHTML = 'Please configure your Linkwarden URL and API Token in the <a href="#" id="open-options">Extension Options</a>.';
    messageEl.classList.remove('hidden');
    document.getElementById('open-options').addEventListener('click', (e) => {
      e.preventDefault();
      browser.runtime.openOptionsPage();
    });
    return;
  }

  try {
    const response = await fetch(`${linkwardenUrl}/api/v1/links`, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    const data = await response.json();
    const links = data.response || [];

    if (links.length === 0) {
      messageEl.textContent = 'No bookmarks found in Linkwarden.';
      messageEl.classList.remove('hidden');
      return;
    }

    gridEl.innerHTML = '';
    links.forEach(item => {
      const card = document.createElement('a');
      card.className = 'card';
      card.href = item.url;

      const icon = document.createElement('img');
      card.className = 'card';
      icon.className = 'icon';

      // Fallback favicon if unavailable from Linkwarden
      const domain = new URL(item.url).hostname;
      icon.src = item.favIcon || `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
      icon.onerror = () => { icon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌐</text></svg>'; };

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = item.name || item.url;

      card.appendChild(icon);
      card.appendChild(title);
      gridEl.appendChild(card);
    });
  } catch (error) {
    messageEl.textContent = `Failed to fetch bookmarks: ${error.message}`;
    messageEl.classList.remove('hidden');
  }
}

document.addEventListener('DOMContentLoaded', fetchLinkwardenBookmarks);
