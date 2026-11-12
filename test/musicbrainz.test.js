import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { MusicBrainzClient } from '../src/musicbrainz.js';

async function mockServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function withBaseUrl(client, baseUrl) {
  // The client hard-codes musicbrainz.org; patch its private get() target by
  // monkeypatching fetch indirectly through a base override for tests.
  const originalGet = client.get.bind(client);
  client.get = (url) => originalGet(url.replace('https://musicbrainz.org/ws/2', baseUrl));
  return client;
}

test('searchArtists maps MusicBrainz artist results', async (t) => {
  const mock = await mockServer((req, res) => {
    assert.match(req.url, /^\/artist\?/);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      artists: [
        { id: 'artist-1', name: 'Milton Nascimento', disambiguation: 'Brazilian singer', 'life-span': { begin: '1942' } }
      ]
    }));
  });
  t.after(() => mock.server.close());
  const client = withBaseUrl(new MusicBrainzClient('test-agent'), mock.url);
  const results = await client.searchArtists('Milton Nascimento');
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'artist');
  assert.equal(results[0].metadataId, 'artist-1');
  assert.equal(results[0].title, 'Milton Nascimento');
  assert.equal(results[0].year, '1942');
});

test('search() with type=artist delegates to searchArtists', async (t) => {
  const mock = await mockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ artists: [{ id: 'a1', name: 'Test Artist' }] }));
  });
  t.after(() => mock.server.close());
  const client = withBaseUrl(new MusicBrainzClient('test-agent'), mock.url);
  const results = await client.search('Test Artist', 'artist');
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'artist');
});

test('getArtistAlbums returns albums sorted by year', async (t) => {
  const mock = await mockServer((req, res) => {
    assert.match(req.url, /^\/release-group\?/);
    assert.match(req.url, /artist=artist-1/);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      'release-groups': [
        { id: 'rg-2', title: 'Later Album', 'first-release-date': '2005-01-01', 'primary-type': 'Album', 'artist-credit': [{ name: 'Milton Nascimento' }] },
        { id: 'rg-1', title: 'Clube da Esquina', 'first-release-date': '1972-03-01', 'primary-type': 'Album', 'artist-credit': [{ name: 'Milton Nascimento' }] }
      ]
    }));
  });
  t.after(() => mock.server.close());
  const client = withBaseUrl(new MusicBrainzClient('test-agent'), mock.url);
  const albums = await client.getArtistAlbums('artist-1');
  assert.equal(albums.length, 2);
  assert.equal(albums[0].title, 'Clube da Esquina');
  assert.equal(albums[0].year, '1972');
  assert.equal(albums[1].title, 'Later Album');
  assert.equal(albums[0].artist, 'Milton Nascimento');
});
