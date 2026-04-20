# musicxml-player

A pure front-end MusicXML score viewer and player built with **OpenSheetMusicDisplay (OSMD)** + **osmd-audio-player**.

## Features

- Load MusicXML from:
  - Local upload (`.xml` / `.mxl`)
  - Remote URL
  - Built-in `sample.xml`
- Render sheet music with title/composer metadata via OSMD
- Zoom in / zoom out score display
- Playback controls: Play / Pause / Stop
- Cursor-follow highlighting during playback
- BPM and volume sliders
- Loading and friendly error states (including URL/CORS guidance)
- Responsive layout with dark top navigation and white content area

## Usage

### Option 1: Open directly

Open `index.html` in a browser.

> Note: Some browsers block `fetch()` from `file://` URLs. If sample loading fails, use Option 2.

### Option 2: Run via static hosting (recommended)

- Use GitHub Pages, or
- Serve locally with any static server (for example: `python3 -m http.server`)

Then open the served URL and use the toolbar to load a file, URL, or the sample score.
With the example command above, open `http://localhost:8000`.

## Screenshot

Add screenshot here after deployment, for example:

- `docs/screenshot.png` (placeholder)

## Dependencies (CDN)

- OSMD:
  - `https://cdn.jsdelivr.net/npm/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js`
- osmd-audio-player:
  - `https://cdn.jsdelivr.net/npm/osmd-audio-player/build/osmd-audio-player.min.js`
- Tone.js fallback (when audio player CDN is unavailable):
  - `https://cdn.jsdelivr.net/npm/tone@14.8.49/build/Tone.js`
