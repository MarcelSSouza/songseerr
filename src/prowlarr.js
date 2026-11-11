import { createHash } from 'node:crypto';
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

function candidateId(release) {
  return createHash('sha256').update(`${release.guid}\0${release.downloadUrl}`).digest('hex').slice(0, 32);
}

function publicCandidate(release, id) {
  const { downloadUrl: _privateUrl, guid: _privateGuid, ...safe } = release;
  return { ...safe, candidateId: id };
}

export class ProwlarrClient {
  constructor(config) {
    this.url = config.url;
    this.apiKey = config.apiKey;
    this.candidates = new Map();
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
    const ranked = rankReleases((Array.isArray(results) ? results : []).map(normalize), quality);
    const now = Date.now();
    for (const [id, entry] of this.candidates) {
      if (now - entry.createdAt > 15 * 60 * 1000) this.candidates.delete(id);
    }
    return ranked.map((release) => {
      const id = candidateId(release);
      this.candidates.set(id, { release, createdAt: now });
      return publicCandidate(release, id);
    });
  }

  async downloadNzb(id) {
    this.assertConfigured();
    const entry = this.candidates.get(id);
    if (!entry) throw Object.assign(new Error('Release candidate expired; search again'), { status: 409 });
    const url = new URL(entry.release.downloadUrl, this.url);
    if (url.origin !== new URL(this.url).origin) {
      throw new Error('Prowlarr returned a download URL outside its configured origin');
    }
    // Usenet indexers legitimately 302-redirect Prowlarr's download link to the
    // indexer's own NZB file host (e.g. Newznab "redirect" mode, required by
    // Prowlarr for all usenet indexers). The redirect target is fetched
    // server-side only; its bytes never reach the browser, so following it is
    // safe as long as the *initial* request stayed within Prowlarr's origin.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, {
        headers: { 'X-Api-Key': this.apiKey, Accept: 'application/x-nzb, application/octet-stream' },
        signal: controller.signal,
        redirect: 'follow'
      });
      if (!response.ok) throw new Error(`Prowlarr NZB download failed with HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('Prowlarr returned an invalid NZB size');
      return { bytes, release: publicCandidate(entry.release, id) };
    } finally {
      clearTimeout(timeout);
    }
  }
}
