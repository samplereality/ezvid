# Changelog

All notable changes to ezvid are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com) and the project uses [Semantic Versioning](https://semver.org).

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
