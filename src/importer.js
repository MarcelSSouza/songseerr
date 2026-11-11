import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probeAudio, verifyDecode, writeTaggedCopy } from './media.js';

const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3']);

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function safeSegment(value, fallback = 'Unknown') {
  const sanitized = String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 140);
  if (!sanitized || sanitized === '.' || sanitized === '..') return fallback;
  return sanitized;
}

function normalize(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function tag(tags, ...names) {
  for (const name of names) {
    const key = Object.keys(tags || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (key && String(tags[key]).trim()) return String(tags[key]).trim();
  }
  return '';
}

function attention(message) {
  return Object.assign(new Error(message), { code: 'NEEDS_ATTENTION' });
}

export class MusicImporter {
  constructor({ store, downloadDir, sabCompleteDir, libraryDir, dataDir, ffprobePath = 'ffprobe', ffmpegPath = 'ffmpeg' }) {
    this.store = store;
    this.downloadDir = downloadDir;
    this.sabCompleteDir = sabCompleteDir;
    this.libraryDir = libraryDir;
    this.dataDir = dataDir;
    this.ffprobePath = ffprobePath;
    this.ffmpegPath = ffmpegPath;
    this.running = false;
  }

  get configured() {
    return Boolean(this.downloadDir && this.sabCompleteDir && this.libraryDir
      && path.isAbsolute(this.downloadDir) && path.isAbsolute(this.sabCompleteDir) && path.isAbsolute(this.libraryDir));
  }

  async importNext() {
    if (!this.configured || this.running) return false;
    const request = this.store.listByStatuses(['import_pending'])[0];
    if (!request) return false;
    const claimed = await this.store.transition(request.id, ['import_pending'], 'inspecting', {
      import: { ...request.import, attempt: Number(request.import?.attempt || 0) + 1, error: null }
    });
    if (!claimed) return false;
    this.running = true;
    try {
      const outputs = await this.importRequest(claimed);
      await this.store.transition(claimed.id, ['inspecting', 'importing'], 'available', {
        import: { ...claimed.import, source: null, files: outputs.map((file) => path.basename(file)), error: null }
      });
      return true;
    } catch (error) {
      await this.store.transition(claimed.id, ['inspecting', 'importing'], error.code === 'NEEDS_ATTENTION' ? 'needs_attention' : 'import_failed', {
        import: { ...claimed.import, source: null, files: [], error: error.code === 'NEEDS_ATTENTION' ? 'ambiguous_or_existing_destination' : 'media_import_failed' }
      });
      return false;
    } finally {
      this.running = false;
    }
  }

  async mapSource(storage) {
    if (!storage || !path.isAbsolute(storage)) throw new Error('SABnzbd completion path is invalid');
    const remoteRelative = path.relative(this.sabCompleteDir, storage);
    if (!isWithin(this.sabCompleteDir, storage) || path.isAbsolute(remoteRelative)) throw new Error('SABnzbd completion path is outside the configured root');
    const downloadRoot = await realpath(this.downloadDir);
    const source = await realpath(path.resolve(downloadRoot, remoteRelative));
    if (!isWithin(downloadRoot, source)) throw new Error('Mapped download path escapes the configured root');
    const sourceStat = await lstat(source);
    if (sourceStat.isSymbolicLink() || (!sourceStat.isDirectory() && !sourceStat.isFile())) throw new Error('Download source is not a regular file or directory');
    return source;
  }

  async discoverAudio(source) {
    const files = [];
    const walk = async (entry) => {
      const stat = await lstat(entry);
      if (stat.isSymbolicLink()) throw new Error('Symlinks are not allowed in completed downloads');
      if (stat.isFile()) {
        if (AUDIO_EXTENSIONS.has(path.extname(entry).toLowerCase())) files.push(entry);
        return;
      }
      if (!stat.isDirectory()) throw new Error('Special files are not allowed in completed downloads');
      for (const child of await readdir(entry, { withFileTypes: true })) {
        if (child.isSymbolicLink()) throw new Error('Symlinks are not allowed in completed downloads');
        await walk(path.join(entry, child.name));
      }
    };
    await walk(source);
    if (!files.length) throw new Error('No FLAC or MP3 files found in completed download');
    return files.sort();
  }

  selectSong(request, candidates) {
    const wantedId = normalize(request.metadataId);
    const byId = candidates.filter(({ probe }) => {
      const id = tag(probe.tags, 'MUSICBRAINZ_TRACKID', 'MUSICBRAINZ_RECORDINGID');
      return wantedId && normalize(id) === wantedId;
    });
    if (byId.length === 1) return byId;

    const wantedTitle = normalize(request.title);
    const wantedArtist = normalize(request.artist);
    const wantedDuration = Number(request.durationMs || 0) / 1000;
    const matches = candidates.filter(({ file, probe }) => {
      const candidateTitle = normalize(tag(probe.tags, 'title') || path.basename(file, path.extname(file)).replace(/^\d+[ ._-]+/, ''));
      const candidateArtist = normalize(tag(probe.tags, 'artist', 'album_artist'));
      const titleMatches = candidateTitle === wantedTitle;
      const artistMatches = !wantedArtist || !candidateArtist || candidateArtist === wantedArtist;
      const durationMatches = !wantedDuration || Math.abs(probe.duration - wantedDuration) <= Math.max(3, wantedDuration * 0.03);
      return titleMatches && artistMatches && durationMatches;
    });
    if (matches.length !== 1) throw attention('Requested song could not be identified unambiguously');
    return matches;
  }

  async importRequest(request) {
    const source = await this.mapSource(request.import?.source);
    const files = await this.discoverAudio(source);
    const candidates = [];
    for (const file of files) {
      const probe = await probeAudio(file, this.ffprobePath);
      if (!['flac', 'mp3'].includes(probe.codec)) throw new Error(`Unsupported codec: ${probe.codec}`);
      candidates.push({ file, probe });
    }
    const selected = request.type === 'song' ? this.selectSong(request, candidates) : candidates;
    const libraryRoot = await realpath(this.libraryDir).catch(async (error) => {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(this.libraryDir, { recursive: true, mode: 0o755 });
      return realpath(this.libraryDir);
    });
    const artist = safeSegment(request.artist, 'Unknown Artist');
    const album = safeSegment(request.album || request.title, 'Unknown Album');
    const destinationDir = path.resolve(libraryRoot, artist, album);
    if (!isWithin(libraryRoot, destinationDir)) throw new Error('Generated destination escaped the library root');
    const stageRoot = path.join(libraryRoot, '.songseerr-staging');
    const stage = path.join(stageRoot, request.id);
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true, mode: 0o700 });
    const outputs = [];
    try {
      for (let index = 0; index < selected.length; index += 1) {
        const { file, probe } = selected[index];
        const title = request.type === 'song' ? request.title : tag(probe.tags, 'title') || path.basename(file, path.extname(file));
        const trackRaw = tag(probe.tags, 'track') || String(index + 1);
        const track = Number.parseInt(trackRaw, 10);
        const prefix = Number.isFinite(track) ? `${String(track).padStart(2, '0')} - ` : '';
        const filename = `${prefix}${safeSegment(title, `Track ${index + 1}`)}.${probe.codec}`;
        const stageFile = path.join(stage, filename);
        await writeTaggedCopy(file, stageFile, {
          title,
          artist: request.type === 'song' ? request.artist : tag(probe.tags, 'artist') || request.artist,
          album: request.album || tag(probe.tags, 'album') || request.title,
          album_artist: request.artist || tag(probe.tags, 'album_artist'),
          track: trackRaw,
          MUSICBRAINZ_RECORDINGID: request.type === 'song' ? request.metadataId : tag(probe.tags, 'MUSICBRAINZ_RECORDINGID', 'MUSICBRAINZ_TRACKID')
        }, probe.codec, this.ffmpegPath);
        const outputProbe = await probeAudio(stageFile, this.ffprobePath);
        if (outputProbe.codec !== probe.codec || Math.abs(outputProbe.duration - probe.duration) > 1) throw new Error('Generated audio verification failed');
        await verifyDecode(stageFile, this.ffmpegPath);
        outputs.push({ stageFile, filename, size: outputProbe.size });
      }

      await mkdir(path.dirname(destinationDir), { recursive: true, mode: 0o755 });
      const manifest = { requestId: request.id, type: request.type, files: outputs.map(({ filename, size }) => ({ filename, size })) };
      if (request.type === 'album') {
        try {
          await lstat(destinationDir);
          throw attention('Album destination already exists');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await writeFile(path.join(stage, '.songseerr.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await rename(stage, destinationDir);
        return outputs.map(({ filename }) => path.join(destinationDir, filename));
      }

      await mkdir(destinationDir, { recursive: true, mode: 0o755 });
      const published = [];
      for (const output of outputs) {
        const destination = path.join(destinationDir, output.filename);
        try {
          await link(output.stageFile, destination);
        } catch (error) {
          if (error.code === 'EEXIST') throw attention('Song destination already exists');
          if (error.code === 'EXDEV') await copyFile(output.stageFile, destination, constants.COPYFILE_EXCL);
          else throw error;
        }
        published.push(destination);
      }
      await writeFile(path.join(destinationDir, `.${request.id}.songseerr.json`), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rm(stage, { recursive: true, force: true });
      return published;
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }
}
