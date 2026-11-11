import path from 'node:path';

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

export function loadConfig(env = process.env) {
  return {
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT || 8788),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    musicBrainzUserAgent: env.MUSICBRAINZ_USER_AGENT || 'SongSeerr/0.1.0 (self-hosted)',
    prowlarr: {
      url: trimSlash(env.PROWLARR_URL),
      apiKey: env.PROWLARR_API_KEY || ''
    },
    sabnzbd: {
      url: trimSlash(env.SABNZBD_URL),
      apiKey: env.SABNZBD_API_KEY || '',
      category: env.SABNZBD_CATEGORY || 'music'
    },
    defaultQuality: env.DEFAULT_QUALITY || 'flac-preferred'
  };
}

export function configuredServices(config) {
  return {
    musicbrainz: true,
    prowlarr: Boolean(config.prowlarr.url && config.prowlarr.apiKey),
    sabnzbd: Boolean(config.sabnzbd.url && config.sabnzbd.apiKey)
  };
}
