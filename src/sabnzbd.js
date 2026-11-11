export class SabnzbdClient {
  constructor(config) {
    this.url = config.url;
    this.apiKey = config.apiKey;
    this.category = config.category;
  }

  assertConfigured() {
    if (!this.url || !this.apiKey) throw new Error('SABnzbd is not configured');
  }

  async submitNzb(bytes, name = 'release') {
    this.assertConfigured();
    const safeName = String(name || 'release').replace(/[^\p{L}\p{N}._ -]+/gu, '').trim().slice(0, 150) || 'release';
    const form = new FormData();
    form.set('mode', 'addfile');
    form.set('apikey', this.apiKey);
    form.set('output', 'json');
    form.set('cat', this.category);
    form.set('nzbname', safeName);
    form.set('name', new Blob([bytes], { type: 'application/x-nzb' }), `${safeName}.nzb`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${this.url}/api`, { method: 'POST', body: form, signal: controller.signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`SABnzbd returned HTTP ${response.status}`);
      if (body?.status === false) throw new Error(body.error || 'SABnzbd rejected the release');
      return {
        accepted: Boolean(body?.status ?? true),
        downloadId: body?.nzo_ids?.[0] || null
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
