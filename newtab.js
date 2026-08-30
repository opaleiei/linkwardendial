async function fetchAllBookmarks(linkwardenUrl, apiToken) {
  let allLinks = [];
  let cursor = null;
  let hasMore = true;
  let pageCount = 0;

  // Pagination loop to fetch all pages
  while (hasMore && pageCount < 50) {
    pageCount++;
    let url = `${linkwardenUrl}/api/v1/links`;
    if (cursor !== null && cursor !== undefined) {
      url += `?cursor=${cursor}`;
    }

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    const data = await response.json();
    let currentBatch = [];
    let nextCursor = null;

    if (Array.isArray(data.response)) {
      currentBatch = data.response;
      nextCursor = data.nextCursor || null;
    } else if (data.response && Array.isArray(data.response.links)) {
      currentBatch = data.response.links;
      nextCursor = data.response.nextCursor || null;
    } else if (data.data && Array.isArray(data.data.links)) {
      currentBatch = data.data.links;
      nextCursor = data.data.nextCursor || null;
    } else if (Array.isArray(data)) {
      currentBatch = data;
    }

    if (currentBatch.length === 0) {
      hasMore = false;
    } else {
      allLinks.push(...currentBatch);
      if (nextCursor && nextCursor !== cursor) {
        cursor = nextCursor;
      } else {
        hasMore = false;
      }
    }
  }

  // Sort descending: highest ID or latest createdAt timestamp first
  return allLinks.sort((a, b) => {
    if (a.createdAt && b.createdAt) {
      return new Date(b.createdAt) - new Date(a.createdAt);
    }
    return (b.id || 0) - (a.id || 0);
  });
}

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
    const links = await fetchAllBookmarks(linkwardenUrl, apiToken);

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
      icon.className = 'icon';

      const domain = new URL(item.url).hostname;
      icon.src = item.favIcon || `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
      icon.onerror = () => {
        icon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌐</text></svg>';
      };

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
