async function fetchAllBookmarks(linkwardenUrl, apiToken) {
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

  const seen = new Set();
  const uniqueLinks = [];
  for (const link of allLinks) {
    const key = link.id || link.url;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueLinks.push(link);
    }
  }

  // Sort ascending: oldest / first added first
  uniqueLinks.sort((a, b) => {
    const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;

    if (dateA && dateB && dateA !== dateB) {
      return dateA - dateB;
    }

    const idA = Number(a.id) || 0;
    const idB = Number(b.id) || 0;
    return idA - idB;
  });

  return uniqueLinks;
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

      try {
        const domain = new URL(item.url).hostname;
        icon.src = item.favIcon || `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
      } catch (e) {
        icon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌐</text></svg>';
      }

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
