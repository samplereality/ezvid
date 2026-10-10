/* ezvid segment engine.
 * Writes a list of [start, end) ranges, possibly from several input files, into one output file.
 * Used for "cut out sections" (the kept pieces of one file) and "join files" (one range per file).
 *
 * Video is either copied packet-by-packet (Quick mode: each piece starts at a keyframe and ends at the last
 * frame that can be decoded without frames beyond the cut) or decoded and re-encoded (Precise mode: exact).
 * Audio is copied at packet granularity when the container can hold it, otherwise re-encoded.
 *
 * Exposes window.EzSegments = { run, keyframeBefore, keyframeAtOrAfter }.
 */
(function (root) {
  'use strict';

  const MB = root.Mediabunny;

  class SegmentsCanceledError extends Error {
    constructor() { super('Cancelled'); this.name = 'SegmentsCanceledError'; }
  }

  /**
   * @param segments  [{ input, videoTrack, audioTrack, start, end }]
   * @param opts {
   *   output: MB.Output (not yet started),
   *   videoOut: boolean, audioOut: boolean,
   *   videoMode: 'copy' | 'encode', videoEncoding: VideoEncodingConfig (when encoding),
   *   audioMode: 'copy' | 'encode', audioEncoding: AudioEncodingConfig (when encoding),
   *   onProgress?: (fraction, processedSeconds) => void,
   *   signal?: { cancelled: boolean },
   * }
   * @returns { pieces: [{ requestedStart, requestedEnd, start, end }], duration }
   */
  async function run(segments, opts) {
    const { output } = opts;
    const signal = opts.signal || { cancelled: false };
    const first = segments[0];
    let videoSource = null;
    let audioSource = null;

    if (opts.videoOut) {
      if (opts.videoMode === 'copy') {
        const codec = await first.videoTrack.getCodec();
        videoSource = new MB.EncodedVideoPacketSource(codec);
        const meta = { rotation: await first.videoTrack.getRotation() };
        const dc = await first.videoTrack.getDecoderConfig();
        if (dc) meta.decoderConfig = dc;
        output.addVideoTrack(videoSource, meta);
      } else {
        videoSource = new MB.VideoSampleSource({ sizeChangeBehavior: 'contain', ...opts.videoEncoding });
        output.addVideoTrack(videoSource);
      }
    }
    if (opts.audioOut) {
      if (opts.audioMode === 'copy') {
        const codec = await first.audioTrack.getCodec();
        audioSource = new MB.EncodedAudioPacketSource(codec);
        const meta = {};
        const dc = await first.audioTrack.getDecoderConfig();
        if (dc) meta.decoderConfig = dc;
        output.addAudioTrack(audioSource, meta);
      } else {
        audioSource = new MB.AudioSampleSource(opts.audioEncoding);
        output.addAudioTrack(audioSource);
      }
    }

    await output.start();

    const total = segments.reduce((a, s) => a + Math.max(0, s.end - s.start), 0);
    let offset = 0;   // output timeline position where the current piece begins
    let done = 0;     // input seconds already written (for progress)
    let seq = 0;      // our own monotonically increasing packet sequence numbers
    const pieces = [];

    const report = (segStart, inputTime) => {
      if (opts.onProgress && total > 0) {
        const processed = done + Math.max(0, inputTime - segStart);
        opts.onProgress(Math.min(1, processed / total), processed);
      }
    };

    for (const seg of segments) {
      if (signal.cancelled) throw new SegmentsCanceledError();

      // Resolve where this piece really starts. In copy mode it must be a keyframe.
      let segStart = seg.start;
      let startPacket = null;
      if (opts.videoOut && opts.videoMode === 'copy') {
        const sink = new MB.EncodedPacketSink(seg.videoTrack);
        startPacket = (await sink.getKeyPacket(seg.start, { verifyKeyPackets: true }))
          || (await sink.getFirstKeyPacket({ verifyKeyPackets: true }));
        if (!startPacket) throw new Error('No keyframe found in the video track.');
        segStart = startPacket.timestamp;
      }
      const segEnd = seg.end;
      if (segEnd <= segStart) { pieces.push({ requestedStart: seg.start, requestedEnd: seg.end, start: segStart, end: segStart }); continue; }

      const gens = [];
      if (opts.videoOut) {
        gens.push(opts.videoMode === 'copy'
          ? videoCopy(seg, segStart, segEnd, offset, startPacket, videoSource, () => seq++)
          : videoEncode(seg, segStart, segEnd, offset, videoSource));
      }
      if (opts.audioOut) {
        gens.push(opts.audioMode === 'copy'
          ? audioCopy(seg, segStart, segEnd, offset, audioSource, () => seq++)
          : audioEncode(seg, segStart, segEnd, offset, audioSource));
      }

      await interleave(gens, signal, (inputTime) => report(segStart, inputTime));

      const kept = segEnd - segStart;
      pieces.push({ requestedStart: seg.start, requestedEnd: seg.end, start: segStart, end: segEnd });
      offset += kept;
      done += Math.max(0, seg.end - seg.start);
    }

    if (signal.cancelled) throw new SegmentsCanceledError();
    await output.finalize();
    if (opts.onProgress) opts.onProgress(1, total);
    return { pieces, duration: offset };
  }

  // Each generator yields { time: inputTimestamp, write: () => Promise }. Items from several generators are written
  // in timestamp order so the muxer can interleave video and audio without buffering a whole piece.
  async function interleave(gens, signal, onItem) {
    const heads = [];
    for (const g of gens) heads.push({ g, cur: await g.next() });
    try {
      for (;;) {
        if (signal.cancelled) throw new SegmentsCanceledError();
        const live = heads.filter((h) => !h.cur.done);
        if (!live.length) break;
        let best = live[0];
        for (const h of live) if (h.cur.value.time < best.cur.value.time) best = h;
        await best.cur.value.write();
        if (onItem) onItem(best.cur.value.time);
        best.cur = await best.g.next();
      }
    } finally {
      for (const h of heads) {
        // An item that was yielded but never written still owns a decoded sample; release it.
        if (h.cur && !h.cur.done && h.cur.value.dispose) { try { h.cur.value.dispose(); } catch (_) { /* ignore */ } }
        try { await h.g.return(); } catch (_) { /* ignore */ }
      }
    }
  }

  // ---- Video: packet copy ----
  // Keeps the decode-order prefix starting at the keyframe at/before `segStart` and stopping at the first packet whose
  // presentation time reaches `segEnd`. A prefix of decode order is always decodable, so no corruption at the cut;
  // at most a couple of B-frames right before the cut are dropped (the last frame simply holds a little longer).
  async function* videoCopy(seg, segStart, segEnd, offset, startPacket, source, nextSeq) {
    const sink = new MB.EncodedPacketSink(seg.videoTrack);
    for await (const p of sink.packets(startPacket)) {
      if (p.timestamp >= segEnd) break;
      const ts = p.timestamp - segStart + offset;
      const dur = Math.min(p.duration, segEnd - p.timestamp);
      const packet = new MB.EncodedPacket(p.data, p.type, ts, dur, nextSeq(), p.byteLength, p.sideData);
      yield { time: p.timestamp, write: () => source.add(packet) };
    }
  }

  // ---- Video: decode + encode ----
  async function* videoEncode(seg, segStart, segEnd, offset, source) {
    const sink = new MB.VideoSampleSink(seg.videoTrack);
    for await (const s of sink.samples(segStart, segEnd)) {
      let ts = s.timestamp;
      let dur = s.duration;
      if (ts < segStart) { dur -= segStart - ts; ts = segStart; }   // first frame may begin before the cut
      if (ts + dur > segEnd) dur = segEnd - ts;
      if (dur <= 0) { s.close(); continue; }
      s.setTimestamp(ts - segStart + offset);
      s.setDuration(dur);
      const inputTime = ts;
      yield { time: inputTime, write: () => source.add(s).finally(() => s.close()), dispose: () => s.close() };
    }
  }

  // ---- Audio: packet copy ----
  // Audio packets are independent, so any run of whole packets is valid. Keeps packets that start inside the piece.
  async function* audioCopy(seg, segStart, segEnd, offset, source, nextSeq) {
    const sink = new MB.EncodedPacketSink(seg.audioTrack);
    const startPacket = (await sink.getPacket(segStart)) || (await sink.getFirstPacket());
    if (!startPacket) return;
    for await (const p of sink.packets(startPacket)) {
      if (p.timestamp >= segEnd) break;
      if (p.timestamp < segStart - 1e-6) continue;
      const ts = p.timestamp - segStart + offset;
      const packet = new MB.EncodedPacket(p.data, p.type, ts, p.duration, nextSeq(), p.byteLength, p.sideData);
      yield { time: p.timestamp, write: () => source.add(packet) };
    }
  }

  // ---- Audio: decode + encode ----
  async function* audioEncode(seg, segStart, segEnd, offset, source) {
    const sink = new MB.AudioSampleSink(seg.audioTrack);
    for await (const s of sink.samples(segStart, segEnd)) {
      if (s.timestamp < segStart - 1e-6) { s.close(); continue; }
      s.setTimestamp(s.timestamp - segStart + offset);
      const inputTime = s.timestamp;
      yield { time: inputTime, write: () => source.add(s).finally(() => s.close()), dispose: () => s.close() };
    }
  }

  // ---- Keyframe helpers for the UI ----
  async function keyframeBefore(videoTrack, t) {
    const sink = new MB.EncodedPacketSink(videoTrack);
    const p = (await sink.getKeyPacket(t, { metadataOnly: true })) || (await sink.getFirstKeyPacket({ metadataOnly: true }));
    return p ? p.timestamp : 0;
  }
  async function keyframeAtOrAfter(videoTrack, t) {
    const sink = new MB.EncodedPacketSink(videoTrack);
    const at = await sink.getKeyPacket(t, { metadataOnly: true });
    if (at && Math.abs(at.timestamp - t) < 1e-6) return at.timestamp;
    const next = at ? await sink.getNextKeyPacket(at, { metadataOnly: true }) : await sink.getFirstKeyPacket({ metadataOnly: true });
    return next ? next.timestamp : null;
  }

  root.EzSegments = { run, keyframeBefore, keyframeAtOrAfter, SegmentsCanceledError };
})(typeof window !== 'undefined' ? window : globalThis);
