import { fetchJson } from './http-client.js';

export class SabnzbdClient {
  constructor(config) {
    this.url = config.url;
    this.apiKey = config.apiKey;
    this.category = config.category;
  }

  assertConfigured() {
    if (!this.url || !this.apiKey) throw new Error('SABnzbd is not configured');
  }

  async submitUrl(downloadUrl, name = '') {
    this.assertConfigured();
    const params = new URLSearchParams({
      mode: 'addurl',
      name: downloadUrl,
      apikey: this.apiKey,
      output: 'json',
      cat: this.category
    });
    if (name) params.set('nzbname', name);
    const response = await fetchJson(`${this.url}/api?${params}`, {}, 15000);
    if (response?.status === false) throw new Error(response.error || 'SABnzbd rejected the release');
    return {
      accepted: Boolean(response?.status ?? true),
      downloadId: response?.nzo_ids?.[0] || null
    };
  }
}
