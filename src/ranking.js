const LOSSLESS = /\b(FLAC|LOSSLESS|24[ -]?BIT|HI[ -]?RES)\b/i;
const MP3 = /\b(MP3|320\s*KBPS|V0)\b/i;
const BAD = /\b(TRANSCODE|WEBRIP|YOUTUBE|AAC|M4A|OPUS)\b/i;

export function detectFormat(title = '') {
  if (LOSSLESS.test(title)) return 'flac';
  if (MP3.test(title)) return 'mp3';
  return 'unknown';
}

export function scoreRelease(release, quality = 'flac-preferred') {
  const title = release.title || '';
  const format = detectFormat(title);
  let score = Number(release.seeders || 0) * 2;

  if (quality === 'flac-only') score += format === 'flac' ? 1000 : -1000;
  if (quality === 'flac-preferred') score += format === 'flac' ? 1000 : format === 'mp3' ? 300 : 0;
  if (quality === 'mp3-only') score += format === 'mp3' ? 1000 : -1000;
  if (quality === 'mp3-preferred') score += format === 'mp3' ? 1000 : format === 'flac' ? 300 : 0;

  if (BAD.test(title)) score -= 500;
  if (/\b(REPACK|PROPER)\b/i.test(title)) score += 25;
  if (/\b(DELUXE|EXPANDED|REMASTER(?:ED)?)\b/i.test(title)) score += 10;
  return score;
}

function qualityTier(format, quality) {
  if (quality.startsWith('flac')) return format === 'flac' ? 2 : format === 'mp3' ? 1 : 0;
  return format === 'mp3' ? 2 : format === 'flac' ? 1 : 0;
}

export function rankReleases(releases, quality = 'flac-preferred') {
  return releases
    .map((release) => ({
      ...release,
      detectedFormat: detectFormat(release.title),
      score: scoreRelease(release, quality)
    }))
    .filter((release) => release.score > -900)
    .sort((a, b) => qualityTier(b.detectedFormat, quality) - qualityTier(a.detectedFormat, quality)
      || b.score - a.score
      || Number(b.seeders || 0) - Number(a.seeders || 0));
}
