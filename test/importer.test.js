import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RequestStore } from '../src/store.js';
import { MusicImporter } from '../src/importer.js';

const exec = promisify(execFile);

async function createFlac(file, title, artist = 'Test Artist') {
  await exec('ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:a', 'flac', '-metadata', `title=${title}`, '-metadata', `artist=${artist}`,
    '-metadata', 'album=Test Album', '-y', file
  ]);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'songseerr-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const downloads = path.join(root, 'downloads');
  const library = path.join(root, 'library');
  const data = path.join(root, 'data');
  await mkdir(downloads, { recursive: true });
  await mkdir(library, { recursive: true });
  const store = new RequestStore(data);
  await store.init();
  const importer = new MusicImporter({
    store, downloadDir: downloads, sabCompleteDir: downloads, libraryDir: library, dataDir: data
  });
  return { root, downloads, library, store, importer };
}

test('album import verifies and publishes all audio files', { timeout: 30000 }, async (t) => {
  const { downloads, library, store, importer } = await fixture(t);
  const source = path.join(downloads, 'album-job');
  await mkdir(source);
  await createFlac(path.join(source, '01.flac'), 'First Song');
  await createFlac(path.join(source, '02.flac'), 'Second Song');
  const request = await store.create({
    type: 'album', title: 'Test Album', album: 'Test Album', artist: 'Test Artist',
    quality: 'flac-preferred', status: 'import_pending', import: { attempt: 0, source, files: [], error: null }
  });
  assert.equal(await importer.importNext(), true);
  assert.equal(store.get(request.id).status, 'available');
  const files = await readdir(path.join(library, 'Test Artist', 'Test Album'));
  assert.ok(files.includes('01 - First Song.flac'));
  assert.ok(files.includes('02 - Second Song.flac'));
  assert.ok(files.includes('.songseerr.json'));
});

test('song import extracts only the unambiguous requested track', { timeout: 30000 }, async (t) => {
  const { downloads, library, store, importer } = await fixture(t);
  const source = path.join(downloads, 'song-job');
  await mkdir(source);
  await createFlac(path.join(source, '01.flac'), 'Wanted Song');
  await createFlac(path.join(source, '02.flac'), 'Other Song');
  const request = await store.create({
    type: 'song', title: 'Wanted Song', album: 'Test Album', artist: 'Test Artist', durationMs: 6000,
    quality: 'flac-preferred', status: 'import_pending', import: { attempt: 0, source, files: [], error: null }
  });
  assert.equal(await importer.importNext(), true);
  assert.equal(store.get(request.id).status, 'available');
  const files = (await readdir(path.join(library, 'Test Artist', 'Test Album'))).filter((name) => name.endsWith('.flac'));
  assert.deepEqual(files, ['01 - Wanted Song.flac']);
});

test('source mapping rejects paths outside the download root', async (t) => {
  const { root, importer } = await fixture(t);
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'track.flac'), 'not audio');
  await assert.rejects(() => importer.mapSource(outside), /outside the configured root/);
});
