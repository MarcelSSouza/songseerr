# SongSeerr

A Seerr-style request manager for individual songs and albums. It searches MusicBrainz for metadata, searches music indexers through Prowlarr, ranks releases by audio quality, and submits the selected NZB to SABnzbd.

> Initial vertical slice. SongSeerr currently manages requests and starts downloads; automatic completed-download import, audio fingerprint verification, tagging, and Navidrome/Jellyfin refresh are planned next.

## Current features

- Search songs and albums using MusicBrainz.
- Select FLAC-only, FLAC-preferred, MP3-preferred, or MP3-only profiles.
- Search Prowlarr's music category through its v1 API.
- Rank releases by codec hints, seeders, and suspicious-transcode markers.
- Submit selected Usenet releases to SABnzbd.
- Save requests locally when download services are not configured.
- Responsive Seerr-inspired interface.
- No runtime npm dependencies.
- Docker image and Compose configuration.

## Run locally

```bash
cp .env.example .env
# Edit .env with your Prowlarr and SABnzbd URLs/API keys.
npm test
npm start
```

Open `http://localhost:8788`.

## Docker

```bash
cp .env.example .env
docker compose up --build -d
```

When all applications share a Docker network, use their service names, for example:

```dotenv
PROWLARR_URL=http://prowlarr:9696
SABNZBD_URL=http://sabnzbd:8080
```

When SongSeerr runs inside the Hermes Umbrel container, `localhost` refers to that container—not to other Umbrel applications. An Umbrel package or shared Docker network is required for production app-to-app access.

## Configuration

- `PORT`, `HOST`: HTTP listener.
- `DATA_DIR`: persistent request database directory.
- `MUSICBRAINZ_USER_AGENT`: identify this installation to MusicBrainz; include a contact address.
- `PROWLARR_URL`, `PROWLARR_API_KEY`: Prowlarr API connection.
- `SABNZBD_URL`, `SABNZBD_API_KEY`: SABnzbd API connection.
- `SABNZBD_CATEGORY`: defaults to `music`.
- `DEFAULT_QUALITY`: `flac-only`, `flac-preferred`, `mp3-preferred`, or `mp3-only`.

Do not commit `.env`; it is ignored by Git.

## Request flow

1. Search MusicBrainz for a song or album.
2. Song requests are mapped to their album when available, because indexers typically publish complete releases.
3. Search Prowlarr's music category.
4. Rank candidates according to the chosen quality profile.
5. Fetch the selected NZB inside the backend and upload its bytes to SABnzbd; indexer URLs and credentials never reach the browser.
6. Persist request and SABnzbd queue identifiers under `DATA_DIR`.

## Development

```bash
npm run dev
npm test
```

The backend uses Node's built-in HTTP server and test runner. This keeps the first release small and makes it easy to package for Umbrel.

## License

GPL-3.0-only. No Lidarr source has been copied into this initial vertical slice. Any future reuse of Lidarr code will retain required notices and GPLv3 obligations.
