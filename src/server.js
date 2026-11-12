import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, configuredServices } from './config.js';
import { MusicBrainzClient } from './musicbrainz.js';
import { ProwlarrClient } from './prowlarr.js';
import { SabnzbdClient } from './sabnzbd.js';
import { RequestStore } from './store.js';
import { DownloadMonitor } from './download-monitor.js';
import { MusicImporter } from './importer.js';
import { MusicLibrary } from './library.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');
const config = loadConfig();
const store = new RequestStore(config.dataDir);
const musicBrainz = new MusicBrainzClient(config.musicBrainzUserAgent);
const prowlarr = new ProwlarrClient(config.prowlarr);
const sabnzbd = new SabnzbdClient(config.sabnzbd);
const importer = new MusicImporter({
  store,
  downloadDir: config.downloadDir,
  sabCompleteDir: config.sabCompleteDir,
  libraryDir: config.libraryDir,
  dataDir: config.dataDir,
  ffprobePath: config.ffprobePath,
  ffmpegPath: config.ffmpegPath
});
const monitor = new DownloadMonitor({
  store,
  sabnzbd,
  importer: importer.configured ? importer : null,
  intervalMs: config.monitorIntervalMs,
  category: config.sabnzbd.category
});
const library = new MusicLibrary({ libraryDir: config.libraryDir });

function publicRequest(item) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    artist: item.artist,
    album: item.album,
    metadataId: item.metadataId,
    durationMs: item.durationMs,
    year: item.year,
    quality: item.quality,
    status: item.status,
    release: item.release ? {
      title: item.release.title,
      indexer: item.release.indexer,
      detectedFormat: item.release.detectedFormat,
      size: item.release.size
    } : null,
    download: {
      status: item.download?.sabStatus || '',
      progress: Number(item.download?.progress || 0),
      completedAt: item.download?.completedAt || null
    },
    import: {
      attempt: Number(item.import?.attempt || 0),
      files: Array.isArray(item.import?.files) ? item.import.files : [],
      error: item.import?.error || null
    },
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

function validateRequest(input) {
  if (!['song', 'album'].includes(input.type)) throw Object.assign(new Error('type must be song or album'), { status: 400 });
  if (!String(input.title || '').trim()) throw Object.assign(new Error('title is required'), { status: 400 });
  if (!['flac-only', 'flac-preferred', 'mp3-preferred', 'mp3-only'].includes(input.quality)) {
    throw Object.assign(new Error('invalid quality profile'), { status: 400 });
  }
}

function mimeType(file) {
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream';
}

async function serveStatic(urlPath, res) {
  const requested = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(publicDir, requested);
  if (!file.startsWith(`${publicDir}${path.sep}`)) return false;
  try {
    const content = await readFile(file);
    res.writeHead(200, {
      'Content-Type': mimeType(file),
      'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      // coverartarchive.org 307s to archive.org, which then 302s to a
      // per-request regional CDN subdomain (e.g. dn721908.ca.archive.org).
      // Browsers re-check CSP against redirect targets, so both archive.org
      // hosts need to be allowed or every cover image silently fails to load.
      'Content-Security-Policy': "default-src 'self'; img-src 'self' https://coverartarchive.org https://archive.org https://*.archive.org data:; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    });
    res.end(content);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return sendJson(res, 200, {
      name: 'SongSeerr',
      version: '0.2.0',
      services: { ...configuredServices(config), importer: importer.configured },
      defaultQuality: config.defaultQuality
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/search') {
    const query = String(url.searchParams.get('q') || '').trim();
    const type = url.searchParams.get('type') || 'all';
    if (query.length < 2) return sendJson(res, 400, { error: 'Search requires at least two characters' });
    if (!['all', 'song', 'album', 'artist'].includes(type)) return sendJson(res, 400, { error: 'Invalid search type' });
    return sendJson(res, 200, { results: await musicBrainz.search(query, type) });
  }
  const artistAlbumsMatch = url.pathname.match(/^\/api\/artist\/([0-9a-f-]+)\/albums$/i);
  if (req.method === 'GET' && artistAlbumsMatch) {
    return sendJson(res, 200, { results: await musicBrainz.getArtistAlbums(artistAlbumsMatch[1]) });
  }
  if (req.method === 'GET' && url.pathname === '/api/releases') {
    const query = String(url.searchParams.get('q') || '').trim();
    const quality = url.searchParams.get('quality') || config.defaultQuality;
    if (query.length < 2) return sendJson(res, 400, { error: 'Release search requires at least two characters' });
    return sendJson(res, 200, { releases: await prowlarr.search(query, quality) });
  }
  if (req.method === 'GET' && url.pathname === '/api/requests') {
    return sendJson(res, 200, { requests: store.list().map(publicRequest) });
  }
  const requestMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)$/i);
  if (req.method === 'GET' && requestMatch) {
    const item = store.get(requestMatch[1]);
    return item ? sendJson(res, 200, { request: publicRequest(item) }) : sendJson(res, 404, { error: 'Request not found' });
  }
  const retryMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/retry-import$/i);
  if (req.method === 'POST' && retryMatch) {
    const item = store.get(retryMatch[1]);
    if (!item) return sendJson(res, 404, { error: 'Request not found' });
    const updated = await store.transition(item.id, ['import_failed', 'needs_attention'], 'import_pending', {
      import: { ...item.import, error: null }
    });
    if (!updated) return sendJson(res, 409, { error: 'Request cannot be retried from its current state' });
    return sendJson(res, 202, { request: publicRequest(updated) });
  }
  if (req.method === 'POST' && url.pathname === '/api/requests') {
    const input = await bodyJson(req);
    validateRequest(input);
    const item = await store.create({ ...input, status: input.release?.candidateId ? 'submitting' : 'requested' });
    if (!input.release?.candidateId) return sendJson(res, 201, { request: publicRequest(item) });
    try {
      const candidate = await prowlarr.downloadNzb(input.release.candidateId);
      const result = await sabnzbd.submitNzb(candidate.bytes, `${input.artist || ''} - ${input.title}`.trim());
      const updated = await store.update(item.id, {
        release: candidate.release,
        status: 'downloading',
        downloadId: result.downloadId,
        download: { sabStatus: 'Queued', progress: 0, missingPolls: 0, lastSeenAt: new Date().toISOString(), completedAt: null }
      });
      return sendJson(res, 201, { request: publicRequest(updated) });
    } catch (error) {
      await store.update(item.id, { status: 'request_failed', import: { ...item.import, error: 'download_submission_failed' } });
      throw error;
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/library') {
    if (!library.configured) return sendJson(res, 200, { albums: [], singles: [] });
    const force = url.searchParams.get('refresh') === '1';
    return sendJson(res, 200, await library.list({ force }));
  }
  if (req.method === 'GET' && url.pathname === '/api/library/album') {
    const dir = String(url.searchParams.get('path') || '');
    if (!dir) return sendJson(res, 400, { error: 'path is required' });
    return sendJson(res, 200, { tracks: await library.albumTracks(dir) });
  }
  if (req.method === 'GET' && url.pathname === '/api/library/stream') {
    const file = String(url.searchParams.get('path') || '');
    if (!file) return sendJson(res, 400, { error: 'path is required' });
    const { status, size, start, end, contentType, stream } = await library.streamFile(file, req.headers.range);
    res.writeHead(status, {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    });
    stream.on('error', () => res.destroy());
    return stream.pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/api/library/cover') {
    const file = String(url.searchParams.get('path') || '');
    if (!file) return sendJson(res, 400, { error: 'path is required' });
    const { contentType, stream } = await library.coverFile(file);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    stream.on('error', () => res.destroy());
    return stream.pipe(res);
  }
  return sendJson(res, 404, { error: 'API endpoint not found' });
}

export async function createServer() {
  await store.init();
  for (const item of store.listByStatuses(['inspecting', 'importing'])) {
    await store.transition(item.id, ['inspecting', 'importing'], 'import_pending');
  }
  if (configuredServices(config).sabnzbd) monitor.start();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method === 'GET' && await serveStatic(url.pathname, res)) return;
      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = Number(error.status || 500);
      console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname}: ${error.message}`);
      sendJson(res, status, status >= 500 ? { error: 'Request failed' } : { error: error.message });
    }
  });
  server.on('close', () => monitor.stop());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await createServer();
  server.listen(config.port, config.host, () => console.log(`SongSeerr listening on http://${config.host}:${config.port}`));
}
