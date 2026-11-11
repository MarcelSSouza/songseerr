import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { ProwlarrClient } from '../src/prowlarr.js';
import { SabnzbdClient } from '../src/sabnzbd.js';

async function mockServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('Prowlarr client sends API key and ranks results', async (t) => {
  const mock = await mockServer((req, res) => {
    assert.equal(req.headers['x-api-key'], 'test-key');
    assert.match(req.url, /categories=3000/);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      { guid: 'mp3', title: 'Test Album MP3 320kbps', downloadUrl: '/download/1', indexer: 'Mock', seeders: 10 },
      { guid: 'flac', title: 'Test Album FLAC', downloadUrl: '/download/2', indexer: 'Mock', seeders: 1 }
    ]));
  });
  t.after(() => mock.server.close());
  const client = new ProwlarrClient({ url: mock.url, apiKey: 'test-key' });
  const results = await client.search('Test Album');
  assert.equal(results[0].guid, 'flac');
  assert.match(client.authenticatedDownloadUrl('/download/2'), /apikey=test-key/);
});

test('SABnzbd client submits an NZB URL', async (t) => {
  const mock = await mockServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.searchParams.get('mode'), 'addurl');
    assert.equal(url.searchParams.get('cat'), 'music');
    assert.equal(url.searchParams.get('apikey'), 'sab-key');
    assert.equal(url.searchParams.get('name'), 'http://prowlarr/download?n=1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: true, nzo_ids: ['SABnzbd_nzo_abc'] }));
  });
  t.after(() => mock.server.close());
  const client = new SabnzbdClient({ url: mock.url, apiKey: 'sab-key', category: 'music' });
  const result = await client.submitUrl('http://prowlarr/download?n=1', 'Album');
  assert.deepEqual(result, { accepted: true, downloadId: 'SABnzbd_nzo_abc' });
});
