import { fetchJson } from './http-client.js';

const BASE_URL = 'https://musicbrainz.org/ws/2';

function artistCredit(item) {
  return (item['artist-credit'] || []).map((credit) => credit.name).filter(Boolean).join(', ');
}

function coverArtUrl(releaseGroupId) {
  return releaseGroupId ? `https://coverartarchive.org/release-group/${releaseGroupId}/front-250` : null;
}

export class MusicBrainzClient {
  constructor(userAgent) {
    this.userAgent = userAgent;
    this.cache = new Map();
    this.nextRequestAt = 0;
    this.queue = Promise.resolve();
  }

  async get(url) {
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.createdAt < 5 * 60 * 1000) return cached.body;
    const run = async () => {
      const waitMs = Math.max(0, this.nextRequestAt - Date.now());
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      try {
        const body = await fetchJson(url, {
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json' }
        });
        this.cache.set(url, { body, createdAt: Date.now() });
        return body;
      } finally {
        this.nextRequestAt = Date.now() + 1100;
      }
    };
    const request = this.queue.then(run, run);
    this.queue = request.catch(() => undefined);
    return request;
  }

  async search(query, type = 'all', limit = 15) {
    const searches = [];
    if (type === 'all' || type === 'song') searches.push(this.searchSongs(query, limit));
    if (type === 'all' || type === 'album') searches.push(this.searchAlbums(query, limit));
    const groups = await Promise.all(searches);
    return groups.flat().slice(0, limit * (type === 'all' ? 2 : 1));
  }

  async searchSongs(query, limit = 15) {
    const params = new URLSearchParams({ query, fmt: 'json', limit: String(limit) });
    const body = await this.get(`${BASE_URL}/recording?${params}`);
    return (body.recordings || []).map((recording) => {
      const release = recording.releases?.[0];
      const releaseGroupId = release?.['release-group']?.id;
      return {
        type: 'song',
        metadataId: recording.id,
        title: recording.title,
        artist: artistCredit(recording),
        album: release?.title || '',
        year: release?.date?.slice(0, 4) || recording['first-release-date']?.slice(0, 4) || '',
        durationMs: recording.length || null,
        coverUrl: coverArtUrl(releaseGroupId)
      };
    });
  }

  async searchAlbums(query, limit = 15) {
    const params = new URLSearchParams({ query, fmt: 'json', limit: String(limit) });
    const body = await this.get(`${BASE_URL}/release-group?${params}`);
    return (body['release-groups'] || []).map((album) => ({
      type: 'album',
      metadataId: album.id,
      title: album.title,
      artist: artistCredit(album),
      album: album.title,
      year: album['first-release-date']?.slice(0, 4) || '',
      primaryType: album['primary-type'] || '',
      coverUrl: coverArtUrl(album.id)
    }));
  }
}
