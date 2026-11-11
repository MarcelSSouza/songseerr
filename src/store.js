import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class RequestStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'requests.json');
    this.temp = path.join(dataDir, 'requests.tmp');
    this.dataDir = dataDir;
    this.items = [];
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      this.items = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  list() {
    return [...this.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async create(input) {
    const item = {
      id: randomUUID(),
      type: input.type,
      title: input.title,
      artist: input.artist || '',
      album: input.album || '',
      metadataId: input.metadataId || '',
      durationMs: Number.isFinite(Number(input.durationMs)) ? Number(input.durationMs) : null,
      year: input.year || '',
      quality: input.quality || 'flac-preferred',
      status: input.status || 'requested',
      release: input.release || null,
      downloadId: input.downloadId || null,
      download: input.download || { sabStatus: '', progress: 0, missingPolls: 0, lastSeenAt: null, completedAt: null },
      import: input.import || { attempt: 0, source: null, files: [], error: null },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.items.push(item);
    await this.persist();
    return item;
  }

  get(id) {
    return this.items.find((candidate) => candidate.id === id) || null;
  }

  listByStatuses(statuses) {
    const wanted = new Set(statuses);
    return this.items.filter((item) => wanted.has(item.status));
  }

  async transition(id, expectedStatuses, nextStatus, patch = {}) {
    const item = this.get(id);
    if (!item) return null;
    if (!new Set(expectedStatuses).has(item.status)) return false;
    Object.assign(item, patch, { status: nextStatus, updatedAt: new Date().toISOString() });
    await this.persist();
    return item;
  }

  async update(id, patch) {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return null;
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    await this.persist();
    return item;
  }

  async persist() {
    this.writeChain = this.writeChain.then(async () => {
      await writeFile(this.temp, `${JSON.stringify(this.items, null, 2)}\n`, { mode: 0o600 });
      await rename(this.temp, this.file);
    });
    return this.writeChain;
  }
}
