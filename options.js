document.addEventListener('DOMContentLoaded', async () => {
  const { linkwardenUrl, apiToken } = await browser.storage.sync.get(['linkwardenUrl', 'apiToken']);
  if (linkwardenUrl) document.getElementById('serverUrl').value = linkwardenUrl;
  if (apiToken) document.getElementById('apiToken').value = apiToken;
});

document.getElementById('save').addEventListener('click', async () => {
  let url = document.getElementById('serverUrl').value.trim();
  const token = document.getElementById('apiToken').value.trim();

  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }

  await browser.storage.sync.set({ linkwardenUrl: url, apiToken: token });
  const status = document.getElementById('status');
  status.textContent = 'Settings saved successfully!';
  setTimeout(() => { status.textContent = ''; }, 2000);
});
