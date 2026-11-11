import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, configuredServices } from './config.js';
import { MusicBrainzClient } from './musicbrainz.js';
import { ProwlarrClient } from './prowlarr.js';
import { SabnzbdClient } from './sabnzbd.js';
import { RequestStore } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');
const config = loadConfig();
const store = new RequestStore(config.dataDir);
const musicBrainz = new MusicBrainzClient(config.musicBrainzUserAgent);
const prowlarr = new ProwlarrClient(config.prowlarr);
const sabnzbd = new SabnzbdClient(config.sabnzbd);

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
      'Content-Security-Policy': "default-src 'self'; img-src 'self' https://coverartarchive.org data:; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
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
    return sendJson(res, 200, { name: 'SongSeerr', version: '0.1.0', services: configuredServices(config), defaultQuality: config.defaultQuality });
  }
  if (req.method === 'GET' && url.pathname === '/api/search') {
    const query = String(url.searchParams.get('q') || '').trim();
    const type = url.searchParams.get('type') || 'all';
    if (query.length < 2) return sendJson(res, 400, { error: 'Search requires at least two characters' });
    if (!['all', 'song', 'album'].includes(type)) return sendJson(res, 400, { error: 'Invalid search type' });
    return sendJson(res, 200, { results: await musicBrainz.search(query, type) });
  }
  if (req.method === 'GET' && url.pathname === '/api/releases') {
    const query = String(url.searchParams.get('q') || '').trim();
    const quality = url.searchParams.get('quality') || config.defaultQuality;
    if (query.length < 2) return sendJson(res, 400, { error: 'Release search requires at least two characters' });
    return sendJson(res, 200, { releases: await prowlarr.search(query, quality) });
  }
  if (req.method === 'GET' && url.pathname === '/api/requests') {
    return sendJson(res, 200, { requests: store.list() });
  }
  if (req.method === 'POST' && url.pathname === '/api/requests') {
    const input = await bodyJson(req);
    validateRequest(input);
    let status = 'requested';
    let downloadId = null;
    if (input.release?.downloadUrl) {
      const downloadUrl = prowlarr.authenticatedDownloadUrl(input.release.downloadUrl);
      const result = await sabnzbd.submitUrl(downloadUrl, `${input.artist || ''} - ${input.title}`.trim());
      status = 'downloading';
      downloadId = result.downloadId;
    }
    const item = await store.create({ ...input, status, downloadId });
    return sendJson(res, 201, { request: item });
  }
  return sendJson(res, 404, { error: 'API endpoint not found' });
}

export async function createServer() {
  await store.init();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method === 'GET' && await serveStatic(url.pathname, res)) return;
      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = Number(error.status || 500);
      console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname}: ${error.message}`);
      sendJson(res, status, { error: status >= 500 ? 'Request failed' : error.message, detail: error.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await createServer();
  server.listen(config.port, config.host, () => console.log(`SongSeerr listening on http://${config.host}:${config.port}`));
}
