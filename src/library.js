import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.m4a', '.wav', '.ogg']);
const COVER_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'folder.jpg'];

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function splitSingleFilename(filename) {
  // Loose library files commonly follow "Artist - Album - Track.ext";
  // fall back to the bare filename as the title when that pattern is absent.
  const base = path.basename(filename, path.extname(filename));
  const parts = base.split(' - ');
  if (parts.length >= 3) return { artist: parts[0].trim(), album: parts[1].trim(), title: parts.slice(2).join(' - ').trim() };
  if (parts.length === 2) return { artist: parts[0].trim(), album: '', title: parts[1].trim() };
  return { artist: '', album: '', title: base.trim() };
}

export class MusicLibrary {
  constructor({ libraryDir, cacheTtlMs = 60_000 }) {
    this.libraryDir = libraryDir;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = null;
    this.cacheBuiltAt = 0;
  }

  get configured() {
    return Boolean(this.libraryDir && path.isAbsolute(this.libraryDir));
  }

  async resolveRoot() {
    try {
      return await realpath(this.libraryDir);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  // Resolves a client-supplied relative path against the library root and
  // guarantees the result cannot escape it (rejects traversal and symlinks).
  async resolveSafePath(relativePath) {
    const root = await this.resolveRoot();
    if (!root) throw Object.assign(new Error('Library is not available'), { status: 503 });
    const normalized = String(relativePath || '').replace(/\\/g, '/');
    if (!normalized || normalized.includes('\0')) throw Object.assign(new Error('Invalid path'), { status: 400 });
    const candidate = path.resolve(root, normalized);
    if (!isWithin(root, candidate)) throw Object.assign(new Error('Path escapes the library root'), { status: 400 });
    const resolved = await realpath(candidate).catch(() => {
      throw Object.assign(new Error('Not found'), { status: 404 });
    });
    if (!isWithin(root, resolved)) throw Object.assign(new Error('Path escapes the library root'), { status: 400 });
    return resolved;
  }

  async scan() {
    const root = await this.resolveRoot();
    if (!root) return { albums: [], singles: [] };
    const albumsByDir = new Map();
    const singles = [];

    const walk = async (dir, depth) => {
      if (depth > 6) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const audioHere = [];
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) audioHere.push(entry.name);
      }
      if (!audioHere.length) return;
      if (dir === root) {
        // Loose files directly under the library root are treated as singles
        // and grouped by the "Artist - Album - Track" naming convention.
        for (const filename of audioHere) {
          const parsed = splitSingleFilename(filename);
          singles.push({
            path: path.relative(root, path.join(dir, filename)),
            filename,
            title: parsed.title || filename,
            artist: parsed.artist,
            album: parsed.album
          });
        }
        return;
      }
      const relDir = path.relative(root, dir);
      const parentName = path.basename(path.dirname(dir));
      const isNested = path.dirname(dir) !== root;
      let cover = null;
      for (const name of COVER_NAMES) {
        if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === name)) {
          cover = path.join(relDir, entries.find((entry) => entry.name.toLowerCase() === name).name);
          break;
        }
      }
      albumsByDir.set(relDir, {
        path: relDir,
        album: path.basename(dir),
        artist: isNested ? parentName : 'Unknown Artist',
        coverPath: cover,
        trackCount: audioHere.length
      });
    };

    await walk(root, 0);
    const albums = [...albumsByDir.values()].sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album));
    singles.sort((a, b) => (a.artist || '').localeCompare(b.artist || '') || a.title.localeCompare(b.title));
    return { albums, singles };
  }

  async list({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.cache && now - this.cacheBuiltAt < this.cacheTtlMs) return this.cache;
    this.cache = await this.scan();
    this.cacheBuiltAt = now;
    return this.cache;
  }

  async albumTracks(relativeDir) {
    const dir = await this.resolveSafePath(relativeDir);
    const entries = await readdir(dir, { withFileTypes: true });
    const tracks = entries
      .filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return tracks.map((filename) => ({ filename, path: path.join(relativeDir, filename) }));
  }

  async streamFile(relativePath, range) {
    const resolved = await this.resolveSafePath(relativePath);
    const info = await stat(resolved);
    if (!info.isFile()) throw Object.assign(new Error('Not a file'), { status: 400 });
    const ext = path.extname(resolved).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) throw Object.assign(new Error('Not an audio file'), { status: 400 });
    let start = 0;
    let end = info.size - 1;
    let status = 200;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        if (match[1]) start = Number.parseInt(match[1], 10);
        if (match[2]) end = Number.parseInt(match[2], 10);
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < info.size) status = 206;
        else { start = 0; end = info.size - 1; }
      }
    }
    return {
      status,
      size: info.size,
      start,
      end,
      contentType: ext === '.flac' ? 'audio/flac' : ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : ext === '.ogg' ? 'audio/ogg' : 'audio/wav',
      stream: createReadStream(resolved, { start, end })
    };
  }

  async coverFile(relativePath) {
    const resolved = await this.resolveSafePath(relativePath);
    const info = await stat(resolved);
    if (!info.isFile()) throw Object.assign(new Error('Not a file'), { status: 400 });
    const ext = path.extname(resolved).toLowerCase();
    const contentType = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext];
    if (!contentType) throw Object.assign(new Error('Not an image'), { status: 400 });
    return { contentType, stream: createReadStream(resolved) };
  }
}
