import { spawn } from 'node:child_process';

export function runProcess(command, args, { timeoutMs = 120000, maxOutput = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const collect = (target) => (chunk) => {
      size += chunk.length;
      if (size > maxOutput) {
        child.kill('SIGKILL');
        finish(new Error('Media command produced too much output'));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      const result = { code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (code === 0) finish(null, result);
      else finish(new Error(`Media command failed (${code ?? signal}): ${result.stderr.slice(-500)}`));
    });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Media command timed out'));
    }, timeoutMs);
  });
}

export async function probeAudio(file, ffprobePath = 'ffprobe') {
  const entries = 'stream=index,codec_type,codec_name,sample_rate,channels,duration,bit_rate:stream_disposition=attached_pic:stream_tags=title,artist,album,album_artist,track,disc,MUSICBRAINZ_TRACKID,MUSICBRAINZ_RECORDINGID:format=format_name,duration,size,bit_rate:format_tags=title,artist,album,album_artist,track,disc,MUSICBRAINZ_TRACKID,MUSICBRAINZ_RECORDINGID';
  const result = await runProcess(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_entries', entries, '--', file], { timeoutMs: 30000 });
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    throw new Error('ffprobe returned invalid JSON');
  }
  const audio = (body.streams || []).filter((stream) => stream.codec_type === 'audio');
  const video = (body.streams || []).filter((stream) => stream.codec_type === 'video' && Number(stream.disposition?.attached_pic || 0) !== 1);
  if (audio.length !== 1) throw new Error('Audio file must contain exactly one playable audio stream');
  if (video.length) throw new Error('Video streams are not accepted as music');
  const duration = Number(audio[0].duration || body.format?.duration);
  const size = Number(body.format?.size);
  if (!Number.isFinite(duration) || duration < 5) throw new Error('Audio duration is invalid or too short');
  if (!Number.isFinite(size) || size <= 0) throw new Error('Audio size is invalid');
  const tags = { ...(body.format?.tags || {}), ...(audio[0].tags || {}) };
  return {
    codec: String(audio[0].codec_name || '').toLowerCase(),
    duration,
    size,
    sampleRate: Number(audio[0].sample_rate || 0),
    channels: Number(audio[0].channels || 0),
    tags
  };
}

export async function verifyDecode(file, ffmpegPath = 'ffmpeg') {
  await runProcess(ffmpegPath, ['-nostdin', '-v', 'error', '-xerror', '-i', file, '-map', '0:a:0', '-f', 'null', '-'], { timeoutMs: 10 * 60 * 1000 });
}

export async function writeTaggedCopy(input, output, metadata, codec, ffmpegPath = 'ffmpeg') {
  if (!['flac', 'mp3'].includes(codec)) throw new Error(`Unsupported audio codec: ${codec}`);
  const args = ['-nostdin', '-v', 'error', '-xerror', '-i', input, '-map', '0:a:0', '-map_metadata', '0', '-c:a', 'copy'];
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== null && value !== undefined && String(value).trim()) args.push('-metadata', `${key}=${String(value)}`);
  }
  if (codec === 'mp3') args.push('-id3v2_version', '3', '-write_id3v1', '1');
  args.push('-f', codec, output);
  await runProcess(ffmpegPath, args, { timeoutMs: 10 * 60 * 1000 });
}
