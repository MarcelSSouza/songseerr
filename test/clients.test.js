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

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('Prowlarr keeps download URLs server-side and downloads NZB bytes', async (t) => {
  const mock = await mockServer((req, res) => {
    assert.equal(req.headers['x-api-key'], 'test-key');
    if (req.url.startsWith('/api/v1/search')) {
      assert.match(req.url, /categories=3000/);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        { guid: 'mp3', title: 'Test Album MP3 320kbps', downloadUrl: '/download/1', indexer: 'Mock', seeders: 10 },
        { guid: 'flac', title: 'Test Album FLAC', downloadUrl: '/download/2', indexer: 'Mock', seeders: 1 }
      ]));
      return;
    }
    assert.equal(req.url, '/download/2');
    res.writeHead(200, { 'Content-Type': 'application/x-nzb' });
    res.end('<?xml version="1.0"?><nzb></nzb>');
  });
  t.after(() => mock.server.close());
  const client = new ProwlarrClient({ url: mock.url, apiKey: 'test-key' });
  const results = await client.search('Test Album');
  assert.equal(results[0].detectedFormat, 'flac');
  assert.ok(results[0].candidateId);
  assert.equal('downloadUrl' in results[0], false);
  assert.equal('guid' in results[0], false);
  const downloaded = await client.downloadNzb(results[0].candidateId);
  assert.match(Buffer.from(downloaded.bytes).toString(), /<nzb>/);
});

test('SABnzbd client uploads NZB bytes as multipart data', async (t) => {
  const mock = await mockServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api');
    assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
    const body = (await readBody(req)).toString('utf8');
    assert.match(body, /name="mode"\r\n\r\naddfile/);
    assert.match(body, /name="cat"\r\n\r\nmusic/);
    assert.match(body, /name="name"; filename="Artist - Album\.nzb"/);
    assert.match(body, /<nzb><\/nzb>/);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: true, nzo_ids: ['SABnzbd_nzo_abc'] }));
  });
  t.after(() => mock.server.close());
  const client = new SabnzbdClient({ url: mock.url, apiKey: 'sab-key', category: 'music' });
  const result = await client.submitNzb(Buffer.from('<nzb></nzb>'), 'Artist - Album');
  assert.deepEqual(result, { accepted: true, downloadId: 'SABnzbd_nzo_abc' });
});

test('SABnzbd client normalizes queue and history status', async (t) => {
  const mock = await mockServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.searchParams.get('nzo_ids'), 'one,two');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.searchParams.get('mode') === 'queue') {
      res.end(JSON.stringify({ queue: { slots: [{ nzo_id: 'one', status: 'Downloading', percentage: '42.5', cat: 'music' }] } }));
    } else {
      res.end(JSON.stringify({ history: { slots: [{ nzo_id: 'two', status: 'Completed', category: 'music', storage: '/downloads/album' }] } }));
    }
  });
  t.after(() => mock.server.close());
  const client = new SabnzbdClient({ url: mock.url, apiKey: 'sab-key', category: 'music' });
  const queue = await client.queue(['one', 'two']);
  const history = await client.history(['one', 'two']);
  assert.equal(queue.get('one').progress, 42.5);
  assert.equal(history.get('two').status, 'Completed');
  assert.equal(history.get('two').storage, '/downloads/album');
});
