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
    const body = await fetchJson(`${BASE_URL}/recording?${params}`, {
      headers: { 'User-Agent': this.userAgent, Accept: 'application/json' }
    });
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
    const body = await fetchJson(`${BASE_URL}/release-group?${params}`, {
      headers: { 'User-Agent': this.userAgent, Accept: 'application/json' }
    });
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
