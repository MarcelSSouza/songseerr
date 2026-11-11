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

  async requestStatus(mode, downloadIds) {
    this.assertConfigured();
    const ids = [...new Set(downloadIds.filter(Boolean))];
    const combined = new Map();
    for (let offset = 0; offset < ids.length; offset += 50) {
      const batch = ids.slice(offset, offset + 50);
      const params = new URLSearchParams({
        mode,
        output: 'json',
        apikey: this.apiKey,
        nzo_ids: batch.join(',')
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(`${this.url}/api?${params}`, { signal: controller.signal });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body) throw new Error(`SABnzbd ${mode} request failed with HTTP ${response.status}`);
        const slots = body?.[mode]?.slots;
        if (!Array.isArray(slots)) throw new Error(`SABnzbd returned an invalid ${mode} response`);
        for (const slot of slots) {
          const id = slot.nzo_id || slot.nzoId;
          if (!id) continue;
          if (mode === 'queue') {
            const progress = Number.parseFloat(slot.percentage);
            combined.set(id, {
              id,
              status: String(slot.status || ''),
              category: String(slot.cat || ''),
              progress: Number.isFinite(progress) ? progress : 0,
              filename: String(slot.filename || ''),
              timeLeft: String(slot.timeleft || '')
            });
          } else {
            combined.set(id, {
              id,
              status: String(slot.status || ''),
              category: String(slot.category || slot.cat || ''),
              storage: String(slot.storage || ''),
              failMessage: String(slot.fail_message || ''),
              completedAt: slot.completed || slot.completed_at || null
            });
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    return combined;
  }

  queue(downloadIds) {
    return this.requestStatus('queue', downloadIds);
  }

  history(downloadIds) {
    return this.requestStatus('history', downloadIds);
  }
}
