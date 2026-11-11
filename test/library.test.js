import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MusicLibrary } from '../src/library.js';

async function makeLibrary() {
  const dir = await mkdtemp(path.join(tmpdir(), 'songseerr-library-'));
  await mkdir(path.join(dir, 'The Strokes', 'Is This It'), { recursive: true });
  await writeFile(path.join(dir, 'The Strokes', 'Is This It', '01 - Is This It.flac'), 'x');
  await writeFile(path.join(dir, 'The Strokes', 'Is This It', 'cover.jpg'), 'x');
  await writeFile(path.join(dir, 'Loose Artist - Loose Album - Loose Track.mp3'), 'x');
  return { dir, library: new MusicLibrary({ libraryDir: dir }) };
}

test('library scan groups nested folders as albums and roots loose files as singles', async () => {
  const { dir, library } = await makeLibrary();
  try {
    const { albums, singles } = await library.list();
    assert.equal(albums.length, 1);
    assert.equal(albums[0].album, 'Is This It');
    assert.equal(albums[0].artist, 'The Strokes');
    assert.equal(albums[0].trackCount, 1);
    assert.ok(albums[0].coverPath.includes('cover.jpg'));

    assert.equal(singles.length, 1);
    assert.equal(singles[0].artist, 'Loose Artist');
    assert.equal(singles[0].album, 'Loose Album');
    assert.equal(singles[0].title, 'Loose Track');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('library rejects path traversal outside the library root', async () => {
  const { dir, library } = await makeLibrary();
  try {
    await assert.rejects(() => library.streamFile('../outside.flac'), /escapes|Not found/);
    await assert.rejects(() => library.streamFile('The Strokes/../../etc/passwd'), /escapes|Not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('library streams only recognized audio files', async () => {
  const { dir, library } = await makeLibrary();
  try {
    await assert.rejects(() => library.streamFile('The Strokes/Is This It/cover.jpg'), /Not an audio file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
