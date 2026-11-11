const PROCESSING = new Set(['Queued', 'QuickCheck', 'Verifying', 'Repairing', 'Extracting', 'Moving', 'Running']);
const ACTIVE = ['downloading', 'postprocessing', 'download_unknown'];

export class DownloadMonitor {
  constructor({ store, sabnzbd, importer = null, intervalMs = 30000, category = 'music', logger = console }) {
    this.store = store;
    this.sabnzbd = sabnzbd;
    this.importer = importer;
    this.intervalMs = intervalMs;
    this.category = category;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.stopped = true;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (error) {
        this.logger.error(`Download monitor: ${error.message}`);
      } finally {
        if (!this.stopped) {
          this.timer = setTimeout(loop, this.intervalMs);
          this.timer.unref?.();
        }
      }
    };
    this.timer = setTimeout(loop, 1000);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return false;
    this.running = true;
    try {
      const requests = this.store.listByStatuses(ACTIVE).filter((item) => item.downloadId);
      const ids = requests.map((item) => item.downloadId);
      if (ids.length) {
        const [queue, history] = await Promise.all([
          this.sabnzbd.queue(ids),
          this.sabnzbd.history(ids)
        ]);
        for (const request of requests) await this.reconcile(request, queue.get(request.downloadId), history.get(request.downloadId));
      }
      if (this.importer) await this.importer.importNext();
      return true;
    } finally {
      this.running = false;
    }
  }

  async reconcile(request, queued, historical) {
    const now = new Date().toISOString();
    if (historical?.status === 'Completed') {
      if (historical.category && historical.category !== this.category) {
        await this.store.transition(request.id, ACTIVE, 'download_failed', {
          download: { ...request.download, sabStatus: historical.status, lastSeenAt: now },
          import: { ...request.import, error: 'unexpected_download_category' }
        });
        return;
      }
      const next = this.importer ? 'import_pending' : 'downloaded';
      await this.store.transition(request.id, ACTIVE, next, {
        download: { ...request.download, sabStatus: 'Completed', progress: 100, missingPolls: 0, lastSeenAt: now, completedAt: now },
        import: { ...request.import, source: historical.storage || null, error: null }
      });
      return;
    }
    if (historical?.status === 'Failed') {
      await this.store.transition(request.id, ACTIVE, 'download_failed', {
        download: { ...request.download, sabStatus: 'Failed', missingPolls: 0, lastSeenAt: now },
        import: { ...request.import, error: historical.failMessage ? 'sab_download_failed' : 'sab_download_failed' }
      });
      return;
    }
    if (historical && PROCESSING.has(historical.status)) {
      await this.store.transition(request.id, ACTIVE, 'postprocessing', {
        download: { ...request.download, sabStatus: historical.status, missingPolls: 0, lastSeenAt: now }
      });
      return;
    }
    if (queued) {
      await this.store.transition(request.id, ACTIVE, 'downloading', {
        download: { ...request.download, sabStatus: queued.status, progress: queued.progress, missingPolls: 0, lastSeenAt: now }
      });
      return;
    }
    const missingPolls = Number(request.download?.missingPolls || 0) + 1;
    await this.store.transition(request.id, ACTIVE, missingPolls >= 10 ? 'download_unknown' : request.status, {
      download: { ...request.download, missingPolls }
    });
  }
}
