const state = { selected: null, releases: [], status: null, lastResults: null };
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
    container.innerHTML = '<p>No matching songs, albums, or artists were found.</p>';
    return;
  }
  for (const result of results) {
    const card = $('#result-template').content.cloneNode(true);
    card.querySelector('h3').textContent = result.title;
    card.querySelector('.artist').textContent = result.type === 'artist' ? (result.disambiguation || '') : (result.artist || 'Unknown artist');
    card.querySelector('.metadata').textContent = [result.album !== result.title ? result.album : '', result.year, result.primaryType].filter(Boolean).join(' · ');
    card.querySelector('.type-badge').textContent = result.type;
    const image = card.querySelector('img');
    if (result.coverUrl) {
      image.src = result.coverUrl;
      image.addEventListener('error', () => image.remove());
    } else image.remove();
    const button = card.querySelector('.request-button');
    if (result.type === 'artist') {
      button.textContent = 'View albums';
      button.addEventListener('click', () => viewArtistAlbums(result));
    } else {
      button.addEventListener('click', () => openReleases(result));
    }
    container.append(card);
  }
}

async function viewArtistAlbums(artist) {
  state.lastResults = { title: $('#results-title').textContent, results: state.currentResults || [] };
  showMessage('#message', `Loading albums by ${artist.artist}…`);
  try {
    const body = await api(`/api/artist/${encodeURIComponent(artist.metadataId)}/albums`);
    showMessage('#message');
    state.currentResults = body.results;
    $('#results-title').textContent = `Albums by ${artist.artist}`;
    $('#back-to-results').classList.remove('hidden');
    renderResults(body.results);
  } catch (error) {
    showMessage('#message', error.message, true);
  }
}

function backToSearchResults() {
  if (!state.lastResults) return;
  $('#results-title').textContent = state.lastResults.title;
  $('#back-to-results').classList.add('hidden');
  state.currentResults = state.lastResults.results;
  renderResults(state.lastResults.results);
}

async function search(event) {
  event.preventDefault();
  const query = $('#search-input').value.trim();
  const type = $('#search-type').value;
  showMessage('#message', 'Searching MusicBrainz…');
  $('#results-title').textContent = `Results for “${query}”`;
  $('#back-to-results').classList.add('hidden');
  try {
    const body = await api(`/api/search?q=${encodeURIComponent(query)}&type=${type}`);
    showMessage('#message');
    state.currentResults = body.results;
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
  $('#library-view').classList.toggle('hidden', view !== 'library');
  $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  if (view === 'requests') loadRequests();
  if (view === 'library') loadLibrary();
}

function coverUrlFor(relativePath) {
  return relativePath ? `/api/library/cover?path=${encodeURIComponent(relativePath)}` : null;
}

function playTrack(track, queue = [], queueIndex = 0) {
  const audio = $('#player-audio');
  state.queue = queue;
  state.queueIndex = queueIndex;
  audio.src = `/api/library/stream?path=${encodeURIComponent(track.path)}`;
  $('#player-title').textContent = track.title || track.filename;
  $('#player-subtitle').textContent = track.subtitle || '';
  $('#player-bar').classList.remove('hidden');
  audio.play().catch(() => {});
}

function playNextInQueue() {
  const queue = state.queue || [];
  const next = (state.queueIndex ?? 0) + 1;
  if (next < queue.length) playTrack(queue[next], queue, next);
}

async function playAlbum(album) {
  try {
    const body = await api(`/api/library/album?path=${encodeURIComponent(album.path)}`);
    const queue = body.tracks.map((track) => ({ ...track, title: track.filename, subtitle: `${album.artist} — ${album.album}` }));
    if (!queue.length) return showMessage('#library-message', 'This album has no playable tracks.', true);
    playTrack(queue[0], queue, 0);
  } catch (error) {
    showMessage('#library-message', error.message, true);
  }
}

function renderLibrary(data) {
  const albumsContainer = $('#library-albums');
  albumsContainer.className = data.albums.length ? 'cards' : 'cards empty-state';
  albumsContainer.replaceChildren();
  if (!data.albums.length) albumsContainer.innerHTML = '<p>No albums found yet. Requests you complete will show up here.</p>';
  for (const album of data.albums) {
    const card = $('#library-album-template').content.cloneNode(true);
    card.querySelector('h3').textContent = album.album;
    card.querySelector('.artist').textContent = album.artist;
    card.querySelector('.metadata').textContent = `${album.trackCount} track${album.trackCount === 1 ? '' : 's'}`;
    const image = card.querySelector('img');
    const cover = coverUrlFor(album.coverPath);
    if (cover) { image.src = cover; image.addEventListener('error', () => image.remove()); } else image.remove();
    card.querySelector('.request-button').addEventListener('click', () => playAlbum(album));
    albumsContainer.append(card);
  }

  const singlesContainer = $('#library-singles');
  singlesContainer.className = data.singles.length ? 'request-list' : 'request-list empty-state';
  singlesContainer.replaceChildren();
  if (!data.singles.length) singlesContainer.innerHTML = '<p>No loose tracks found.</p>';
  const queue = data.singles.map((single) => ({ ...single, subtitle: single.artist || '' }));
  data.singles.forEach((single, index) => {
    const row = $('#library-single-row-template').content.cloneNode(true);
    row.querySelector('h3').textContent = single.title;
    row.querySelector('.release-meta').textContent = [single.artist, single.album].filter(Boolean).join(' · ');
    row.querySelector('.request-button').addEventListener('click', () => playTrack(queue[index], queue, index));
    singlesContainer.append(row);
  });
}

async function loadLibrary(force = false) {
  showMessage('#library-message', 'Loading your library…');
  try {
    const data = await api(`/api/library${force ? '?refresh=1' : ''}`);
    showMessage('#library-message');
    renderLibrary(data);
  } catch (error) {
    showMessage('#library-message', error.message, true);
  }
}

function initWelcomeDialog() {
  const dialog = $('#welcome-dialog');
  const dontShow = $('#welcome-dontshow');
  const STORAGE_KEY = 'songseerr:welcome-dismissed';
  if (!localStorage.getItem(STORAGE_KEY)) dialog.showModal();
  $('#show-welcome').addEventListener('click', () => {
    dontShow.checked = false;
    dialog.showModal();
  });
  dialog.addEventListener('close', () => {
    if (dontShow.checked) localStorage.setItem(STORAGE_KEY, '1');
  });
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
  $('#back-to-results').addEventListener('click', backToSearchResults);
  $('#rerun-release-search').addEventListener('click', findReleases);
  $('#refresh-requests').addEventListener('click', loadRequests);
  $('#refresh-library').addEventListener('click', () => loadLibrary(true));
  $('#player-audio').addEventListener('ended', playNextInQueue);
  $$('.nav-button').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  initWelcomeDialog();
}

init();
