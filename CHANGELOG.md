# Changelog

All notable changes to ezvid are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com) and the project uses [Semantic Versioning](https://semver.org).

## [0.3.0] - 2026-10-10

### Added
- **Cut out** tab: mark one or more sections to remove; everything else is kept and written as a single file. Removed ranges are drawn on the timeline. In Quick mode the video resumes at the keyframe before each cut's end and the list says exactly where; Precise mode is frame-accurate.
- **Join** tab: append more files and save them as one. Quick mode joins files with the same codec, frame size and encoding settings without re-encoding; Precise mode re-encodes and accepts mixed files (letterboxing them into the first file's frame).
- I / O and [ / ] keys work on the Cut out tab for the cut's start and end.
- A new segment engine (`segments.js`) that writes several ranges, from one or more files, into one output with video and audio interleaved and progress and cancel support.

## [0.2.0] - 2026-10-10

### Added
- Audio options: keep the audio, remove it (silent video), or save audio only as M4A (AAC) or WAV.
- Snapshot button that saves the current frame as a full-resolution PNG.
- Resolution choice (for example 1080p, 720p, 480p) when re-encoding in Precise mode or converting; picking one in Convert re-encodes the video.
- Format, cut mode, quality, audio and resolution choices are remembered between visits.
- Clearer message when the page is loaded over plain http, which hides the browser's encoders.

### Changed
- The −1s / +1s transport buttons became previous / next keyframe buttons; Shift+←/→ do the same.

## [0.1.0] - 2026-10-10

Initial release.

### Added
- Extract a clip between In and Out points, set by typing, from the playhead, or with the I and O keys.
- Trim a chosen amount from the start of a video.
- Quick mode: keyframe-aligned cuts with no re-encoding, with the exact keyframe shown and one-click snapping.
- Precise mode: frame-accurate cuts that re-encode the video with the browser's hardware encoder; audio is copied.
- Convert between MP4, MKV, MOV and WebM, copying streams whenever the container allows and re-encoding otherwise.
- Scrubbable preview with frame stepping and previous/next keyframe jumps.
- Output streams directly to disk in Chrome and Edge; other browsers fall back to an in-memory download.
