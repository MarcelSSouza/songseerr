import { fetchJson } from './http-client.js';
import { rankReleases } from './ranking.js';

function normalize(result) {
  return {
    guid: result.guid || result.downloadUrl || result.title,
    title: result.title || 'Untitled release',
    downloadUrl: result.downloadUrl || '',
    indexer: result.indexer || result.indexerId || 'Unknown indexer',
    protocol: result.protocol || 'usenet',
    size: Number(result.size || 0),
    publishDate: result.publishDate || null,
    seeders: Number(result.seeders || 0),
    leechers: Number(result.leechers || 0),
    categories: result.categories || []
  };
}

export class ProwlarrClient {
  constructor(config) {
    this.url = config.url;
    this.apiKey = config.apiKey;
  }

  assertConfigured() {
    if (!this.url || !this.apiKey) throw new Error('Prowlarr is not configured');
  }

  async search(query, quality = 'flac-preferred') {
    this.assertConfigured();
    const params = new URLSearchParams({ query, type: 'search', categories: '3000' });
    const results = await fetchJson(`${this.url}/api/v1/search?${params}`, {
      headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json' }
    }, 30000);
    return rankReleases((Array.isArray(results) ? results : []).map(normalize), quality);
  }

  authenticatedDownloadUrl(downloadUrl) {
    this.assertConfigured();
    const url = new URL(downloadUrl, this.url);
    if (url.origin === new URL(this.url).origin && !url.searchParams.has('apikey')) {
      url.searchParams.set('apikey', this.apiKey);
    }
    return url.toString();
  }
}
