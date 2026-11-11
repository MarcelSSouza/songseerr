import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, rankReleases, scoreRelease } from '../src/ranking.js';

test('detects common FLAC and MP3 release names', () => {
  assert.equal(detectFormat('Artist Album 2025 FLAC 24bit'), 'flac');
  assert.equal(detectFormat('Artist - Album MP3 320kbps'), 'mp3');
  assert.equal(detectFormat('Artist Album CD'), 'unknown');
});

test('FLAC preferred puts lossless above MP3', () => {
  const ranked = rankReleases([
    { title: 'Album MP3 320kbps', seeders: 100 },
    { title: 'Album FLAC', seeders: 1 }
  ], 'flac-preferred');
  assert.equal(ranked[0].detectedFormat, 'flac');
  assert.ok(ranked[0].score > ranked[1].score);
});

test('strict quality profiles reject the other codec', () => {
  assert.ok(scoreRelease({ title: 'Album MP3 320', seeders: 0 }, 'flac-only') < -900);
  assert.ok(scoreRelease({ title: 'Album FLAC', seeders: 0 }, 'mp3-only') < -900);
});

test('penalizes probable transcodes', () => {
  const clean = scoreRelease({ title: 'Album FLAC', seeders: 0 }, 'flac-preferred');
  const transcode = scoreRelease({ title: 'Album FLAC TRANSCODE', seeders: 0 }, 'flac-preferred');
  assert.ok(clean > transcode);
});
