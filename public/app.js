const state = { selected: null, releases: [], status: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function showMessage(target, text = '', error = false) {
  const element = $(target);
  element.textContent = text;
  element.classList.toggle('hidden', !text);
  element.classList.toggle('error', error);
}

async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.detail || body.error || `HTTP ${response.status}`);
  return body;
}

function formatBytes(bytes) {
  if (!bytes) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function renderResults(results) {
  const container = $('#results');
  container.className = results.length ? 'cards' : 'cards empty-state';
  container.replaceChildren();
  $('#result-count').textContent = `${results.length} result${results.length === 1 ? '' : 's'}`;
  if (!results.length) {
    container.innerHTML = '<p>No matching songs or albums were found.</p>';
    return;
  }
  for (const result of results) {
    const card = $('#result-template').content.cloneNode(true);
    card.querySelector('h3').textContent = result.title;
    card.querySelector('.artist').textContent = result.artist || 'Unknown artist';
    card.querySelector('.metadata').textContent = [result.album !== result.title ? result.album : '', result.year, result.primaryType].filter(Boolean).join(' · ');
    card.querySelector('.type-badge').textContent = result.type;
    const image = card.querySelector('img');
    if (result.coverUrl) {
      image.src = result.coverUrl;
      image.addEventListener('error', () => image.remove());
    } else image.remove();
    card.querySelector('.request-button').addEventListener('click', () => openReleases(result));
    container.append(card);
  }
}

async function search(event) {
  event.preventDefault();
  const query = $('#search-input').value.trim();
  const type = $('#search-type').value;
  showMessage('#message', 'Searching MusicBrainz…');
  $('#results-title').textContent = `Results for “${query}”`;
  try {
    const body = await api(`/api/search?q=${encodeURIComponent(query)}&type=${type}`);
    showMessage('#message');
    renderResults(body.results);
  } catch (error) {
    showMessage('#message', error.message, true);
  }
}

function releaseQuery(item) {
  if (item.type === 'song') return `${item.artist} ${item.album || item.title}`.trim();
  return `${item.artist} ${item.title}`.trim();
}

async function openReleases(item) {
  state.selected = item;
  $('#dialog-title').textContent = `${item.artist} — ${item.title}`;
  $('#release-dialog').showModal();
  await findReleases();
}

async function findReleases() {
  const container = $('#releases');
  container.innerHTML = '';
  showMessage('#release-message', 'Searching configured indexers…');
  const quality = $('#quality').value;
  try {
    const body = await api(`/api/releases?q=${encodeURIComponent(releaseQuery(state.selected))}&quality=${quality}`);
    state.releases = body.releases;
    showMessage('#release-message', body.releases.length ? '' : 'No compatible releases were found.');
    renderReleases();
  } catch (error) {
    const unconfigured = !state.status?.services?.prowlarr;
    showMessage('#release-message', unconfigured ? 'Prowlarr is not configured yet. You can still save this request.' : error.message, !unconfigured);
    renderSaveOnly();
  }
}

function renderSaveOnly() {
  const container = $('#releases');
  const row = document.createElement('div');
  row.className = 'release-row';
  row.innerHTML = '<div><div class="release-title">Save request without starting a download</div><div class="release-meta">It can be processed after Prowlarr and SABnzbd are configured.</div></div>';
  const button = document.createElement('button');
  button.className = 'request-button';
  button.textContent = 'Save request';
  button.addEventListener('click', () => createRequest(null));
  row.append(button);
  container.append(row);
}

function renderReleases() {
  const container = $('#releases');
  container.replaceChildren();
  if (!state.releases.length) return renderSaveOnly();
  for (const release of state.releases) {
    const row = document.createElement('div');
    row.className = 'release-row';
    const details = document.createElement('div');
    details.innerHTML = `<div class="release-title"></div><div class="release-meta"><span class="format ${release.detectedFormat}">${release.detectedFormat}</span> · ${formatBytes(release.size)} · ${release.indexer} · score ${release.score}</div>`;
    details.querySelector('.release-title').textContent = release.title;
    const button = document.createElement('button');
    button.className = 'request-button';
    button.textContent = 'Request';
    button.addEventListener('click', () => createRequest(release));
    row.append(details, button);
    container.append(row);
  }
}

async function createRequest(release) {
  showMessage('#release-message', release ? 'Sending release to SABnzbd…' : 'Saving request…');
  try {
    await api('/api/requests', {
      method: 'POST',
      body: JSON.stringify({ ...state.selected, quality: $('#quality').value, release })
    });
    $('#release-dialog').close();
    await loadRequests();
    switchView('requests');
  } catch (error) {
    showMessage('#release-message', error.message, true);
  }
}

async function loadRequests() {
  const container = $('#requests');
  try {
    const body = await api('/api/requests');
    container.className = body.requests.length ? 'request-list' : 'request-list empty-state';
    container.replaceChildren();
    if (!body.requests.length) return container.innerHTML = '<p>No requests yet.</p>';
    for (const request of body.requests) {
      const row = document.createElement('article');
      row.className = 'request-row';
      const details = document.createElement('div');
      const title = document.createElement('h3');
      title.textContent = `${request.artist ? `${request.artist} — ` : ''}${request.title}`;
      const meta = document.createElement('div');
      meta.className = 'release-meta';
      const progress = request.status === 'downloading' ? ` · ${Math.round(request.download?.progress || 0)}%` : '';
      meta.textContent = `${request.type} · ${request.quality}${progress} · ${new Date(request.createdAt).toLocaleString()}`;
      details.append(title, meta);
      const status = document.createElement('span');
      status.className = `request-status ${request.status}`;
      status.textContent = request.status;
      row.append(details, status);
      container.append(row);
    }
  } catch (error) {
    container.innerHTML = `<p>${error.message}</p>`;
  }
}

function switchView(view) {
  $('#discover-view').classList.toggle('hidden', view !== 'discover');
  $('#requests-view').classList.toggle('hidden', view !== 'requests');
  $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  if (view === 'requests') loadRequests();
}

async function init() {
  try {
    state.status = await api('/api/status');
    const services = Object.entries(state.status.services);
    const active = services.filter(([, value]) => value).map(([name]) => name);
    $('#service-status').textContent = `${active.length}/${services.length} services ready`;
    $('#quality').value = state.status.defaultQuality;
  } catch {
    $('#service-status').textContent = 'Server unavailable';
  }
  $('#search-form').addEventListener('submit', search);
  $('#rerun-release-search').addEventListener('click', findReleases);
  $('#refresh-requests').addEventListener('click', loadRequests);
  $$('.nav-button').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
}

init();
