import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RequestStore } from '../src/store.js';
import { DownloadMonitor } from '../src/download-monitor.js';

async function fixture(t, { queue = new Map(), history = new Map(), importer = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'songseerr-monitor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RequestStore(dir);
  await store.init();
  const request = await store.create({
    type: 'album', title: 'Album', artist: 'Artist', quality: 'flac-preferred',
    status: 'downloading', downloadId: 'nzo-1'
  });
  const sabnzbd = { queue: async () => queue, history: async () => history };
  const monitor = new DownloadMonitor({ store, sabnzbd, importer, category: 'music', logger: { error() {} } });
  return { store, request, monitor };
}

test('monitor updates queue progress', async (t) => {
  const queue = new Map([['nzo-1', { id: 'nzo-1', status: 'Downloading', progress: 42 }]]);
  const { store, request, monitor } = await fixture(t, { queue });
  await monitor.tick();
  assert.equal(store.get(request.id).status, 'downloading');
  assert.equal(store.get(request.id).download.progress, 42);
  assert.equal(store.get(request.id).download.missingPolls, 0);
});

test('completed history wins and queues import', async (t) => {
  let importTicks = 0;
  const queue = new Map([['nzo-1', { id: 'nzo-1', status: 'Downloading', progress: 99 }]]);
  const history = new Map([['nzo-1', { id: 'nzo-1', status: 'Completed', category: 'music', storage: '/downloads/Artist - Album' }]]);
  const importer = { importNext: async () => { importTicks += 1; } };
  const { store, request, monitor } = await fixture(t, { queue, history, importer });
  await monitor.tick();
  const updated = store.get(request.id);
  assert.equal(updated.status, 'import_pending');
  assert.equal(updated.download.progress, 100);
  assert.equal(updated.import.source, '/downloads/Artist - Album');
  assert.equal(importTicks, 1);
});

test('failed history produces terminal download failure', async (t) => {
  const history = new Map([['nzo-1', { id: 'nzo-1', status: 'Failed', category: 'music', failMessage: 'Unpack failed' }]]);
  const { store, request, monitor } = await fixture(t, { history });
  await monitor.tick();
  assert.equal(store.get(request.id).status, 'download_failed');
  assert.equal(store.get(request.id).import.error, 'sab_download_failed');
});

test('missing jobs are not failed immediately', async (t) => {
  const { store, request, monitor } = await fixture(t);
  await monitor.tick();
  assert.equal(store.get(request.id).status, 'downloading');
  assert.equal(store.get(request.id).download.missingPolls, 1);
});
