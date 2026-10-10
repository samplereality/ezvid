# ezvid

Version 0.2.0 · follows [Semantic Versioning](https://semver.org); see `CHANGELOG.md`.

Quick, private video cuts and conversions that run entirely in your browser. A lightweight replacement for the handful of things most people used Avidemux for:

- **Extract a clip** from a longer video (set In/Out points).
- **Trim** a chosen amount off the start of a video.
- **Quick mode** cuts at keyframes with no re-encoding (instant, lossless). **Precise mode** cuts at the exact frame by re-encoding the video with your computer's hardware encoder.
- **Convert** between containers (MP4, MKV, MOV, WebM), copying the video and audio streams untouched whenever the target container can hold them.
- **Audio options:** remove the audio track, or save audio only as M4A or WAV.
- **Downscale** to 1080p, 720p, 480p or 360p whenever the video is being re-encoded.
- **Snapshot** the current frame as a PNG.
- Settings are remembered between visits.

Nothing is uploaded. The file is read straight from disk and the result is streamed straight back to disk, so multi‑gigabyte files are fine.

## Use it

**Hosted:** <https://ezvid.samplereality.com> (GitHub Pages, served from the `main` branch of this repository; the `CNAME` file sets the custom domain). No build step, no server to run.

**Locally:** double‑click `index.html`. It works from a plain `file://` URL; nothing needs to be installed.

Then drop a video onto the page, pick what you want to do, and click **Save**. A normal "Save as…" dialog asks where to put the result.

### Browser support

| | Chrome / Edge | Safari | Firefox |
|---|---|---|---|
| Quick cuts and conversions (no re-encoding) | ✅ | ✅ | ✅ |
| Precise cuts / re-encoding (WebCodecs) | ✅ hardware accelerated | ✅ (16.4+) | ✅ (130+) |
| Stream output straight to disk, any file size | ✅ | ❌ built in memory, then downloaded | ❌ built in memory, then downloaded |

Chrome or Edge is recommended. In Safari and Firefox the output is assembled in memory before download, so very large outputs can fail; short clips are fine.

### Keyboard

Space play/pause · ← / → one frame · Shift+← / → previous / next keyframe · I / O set In / Out · [ / ] jump to In / Out · Home / End.

## How it works

The page is plain HTML, CSS and JavaScript. All media work is done by [Mediabunny](https://mediabunny.dev) (MPL‑2.0, vendored in `vendor/`), a pure‑JavaScript demuxer/muxer that uses the browser's built‑in [WebCodecs](https://developer.mozilla.org/docs/Web/API/WebCodecs_API) decoders and encoders when re-encoding is needed. There is no FFmpeg involved; the WebAssembly build of FFmpeg was considered and rejected because it holds files in a ~2 GB memory heap and re-encodes in slow single‑threaded software, which makes it unusable for long recordings.

What each mode does, in FFmpeg terms:

| ezvid | roughly equivalent to |
|---|---|
| Quick extract | `ffmpeg -ss <keyframe> -to <out> -i in.mp4 -c copy clip.mp4` |
| Precise extract | `ffmpeg -ss <in> -to <out> -i in.mp4 -c:v h264_videotoolbox -c:a copy clip.mp4` |
| Trim start | same as above with no `-to` |
| Convert | `ffmpeg -i in.mp4 -c copy out.mkv` |

In Quick mode the start point snaps to the keyframe at or before your In point; the page tells you exactly where that is and offers one‑click snapping to the previous or next keyframe. The Out point is exact to the nearest packet in both modes. Precise mode re-encodes the whole clip (not just the first group of pictures), matching the source bitrate by default.

## Files

- `index.html`, `styles.css`, `app.js` — the app. The version number lives in `APP_VERSION` at the top of `app.js` and is shown in the page header.
- `vendor/mediabunny.min.js` — the media engine, unmodified from the npm package (`dist/bundles/mediabunny.min.cjs`, 1.61.3). To update it, download a newer release and replace this file.

## Deploying

The site is published by GitHub Pages from the `main` branch (root folder); every push to `main` redeploys it within a minute or so. The custom domain comes from the `CNAME` file. DNS for it lives in cPanel at samplereality.com: a `CNAME` record for `ezvid` pointing to `samplereality.github.io`. After DNS resolves, turn on "Enforce HTTPS" in the repository's Pages settings once GitHub has issued the certificate.

## License

MIT, see `LICENSE`. The vendored Mediabunny engine in `vendor/` is separately licensed under the Mozilla Public License 2.0 (`vendor/LICENSE-mediabunny.txt`); it is included unmodified.
