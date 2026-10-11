/* ezvid — quick cuts & conversions in the browser.
 * Engine: Mediabunny (vendor/mediabunny.min.js) + the browser's WebCodecs.
 * Everything runs locally. Nothing is uploaded.
 */
'use strict';

const APP_VERSION = '0.3.1'; // Semantic Versioning: MAJOR.MINOR.PATCH

const MB = window.Mediabunny;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------- Format and codec tables ----------

const FORMATS = {
  mp4:  { label: 'MP4',  mime: 'video/mp4',         ext: '.mp4',  make: () => new MB.Mp4OutputFormat() },
  mkv:  { label: 'MKV',  mime: 'video/x-matroska',  ext: '.mkv',  make: () => new MB.MkvOutputFormat() },
  mov:  { label: 'MOV',  mime: 'video/quicktime',   ext: '.mov',  make: () => new MB.MovOutputFormat() },
  webm: { label: 'WebM', mime: 'video/webm',        ext: '.webm', make: () => new MB.WebMOutputFormat() },
  m4a:  { label: 'M4A (AAC audio)', mime: 'audio/mp4', ext: '.m4a', make: () => new MB.Mp4OutputFormat(), audioOnly: true },
  wav:  { label: 'WAV (uncompressed audio)', mime: 'audio/wav', ext: '.wav', make: () => new MB.WavOutputFormat(), audioOnly: true },
};
const VIDEO_FORMAT_KEYS = ['mp4', 'mkv', 'mov', 'webm'];
const AUDIO_FORMAT_KEYS = ['m4a', 'wav'];
const RESOLUTIONS = [2160, 1440, 1080, 720, 480, 360];

const CODEC_NAMES = {
  avc: 'H.264', hevc: 'H.265 / HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8', prores: 'ProRes',
  aac: 'AAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', flac: 'FLAC', ac3: 'AC-3', eac3: 'E-AC-3', dts: 'DTS',
};
const codecName = (c) => (c == null ? 'unknown codec' : (CODEC_NAMES[c] || (c.startsWith('pcm') ? 'PCM' : c.toUpperCase())));

// Preferred audio codecs to transcode to, per container, when the source audio can't be copied.
const AUDIO_FALLBACK = { mp4: ['aac', 'opus'], mov: ['aac'], mkv: ['aac', 'opus', 'vorbis'], webm: ['opus', 'vorbis'], m4a: ['aac'], wav: ['pcm-s16', 'pcm-s24', 'pcm-f32'] };

// ---------- State ----------

const state = {
  file: null,
  input: null,
  objectUrl: null,
  duration: 0,
  firstTs: 0,
  formatKey: null,      // detected source container key (mp4/mkv/mov/webm) or null
  formatName: '',
  videoTrack: null,
  audioTrack: null,
  videoCodec: null,
  audioCodec: null,
  width: 0,
  height: 0,
  codedW: 0,
  codedH: 0,
  desc: '',             // codec + decoder description, used to tell whether files can be joined without re-encoding
  fps: 0,
  bitrate: 0,           // sampled average video bitrate (bits/s)
  channels: 0,
  sampleRate: 0,
  packetSink: null,     // EncodedPacketSink on the video track (for keyframe lookup)
  canvasSink: null,     // CanvasSink fallback preview when <video> can't play the file
  snapSink: null,       // full-resolution CanvasSink for snapshots
  previewMode: 'video',
  videoFormat: 'same',  // remembered output format choices
  audioFormat: 'm4a',
  savedResolution: 'keep',
  tab: 'extract',
  inPoint: 0,
  outPoint: 0,
  trimAmount: 0,
  cutFrom: 0,
  cutTo: 0,
  cuts: [],             // ranges to remove (Cut out tab): [{ from, to }], sorted and non-overlapping
  extra: [],            // additional files (Join tab), each a probeFile() entry
  segJob: null,         // { signal, output } while a segment job runs
  keyframe: { prev: null, next: null, for: null }, // keyframes around the active start point
  plan: null,
  conversion: null,
  running: false,
};

const FSA = typeof window.showSaveFilePicker === 'function' && !location.search.includes('nofsa');
const HAS_WEBCODECS = typeof window.VideoEncoder === 'function' && typeof window.VideoDecoder === 'function';

// ---------- Time helpers ----------

function fmtTime(t, { ms = true } = {}) {
  if (!Number.isFinite(t)) t = 0;
  if (t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const sec = ms ? s.toFixed(3).padStart(6, '0') : String(Math.floor(s)).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${sec}` : `${mm}:${sec}`;
}

// Accepts "83.5", "1:23.5", "01:23", "1:02:03.250", "90s". Returns seconds or NaN.
function parseTime(str) {
  const s = String(str).trim().toLowerCase().replace(/s$/, '');
  if (!s) return NaN;
  const parts = s.split(':').map((p) => p.trim());
  if (parts.some((p) => p === '' || !/^\d*(\.\d*)?$/.test(p))) return NaN;
  const nums = parts.map(Number);
  if (nums.some((n) => Number.isNaN(n))) return NaN;
  let t = 0;
  for (const n of nums) t = t * 60 + n;
  return t;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

// ---------- Capability notes ----------

function showCapabilityNotes() {
  const box = $('#capabilityNotes');
  const notes = [];
  if (!MB) {
    notes.push({ kind: 'err', text: 'The media engine (vendor/mediabunny.min.js) failed to load, so nothing will work. Check that the vendor folder is next to index.html.' });
  }
  if (!window.isSecureContext) {
    // Browsers hide WebCodecs and the File System Access API on plain http pages.
    const httpsUrl = location.protocol === 'http:' ? `https://${location.host}${location.pathname}${location.search}` : null;
    const d = document.createElement('div');
    d.className = 'note err';
    d.textContent = 'This page was loaded over plain http, so the browser hides its video encoders and the Save As dialog. Precise cuts and re-encoding will not work until you ';
    if (httpsUrl) {
      const a = document.createElement('a');
      a.href = httpsUrl; a.textContent = 'reload it over https';
      d.appendChild(a);
      d.appendChild(document.createTextNode('.'));
    } else {
      d.appendChild(document.createTextNode('open it from a secure (https) address.'));
    }
    box.innerHTML = '';
    box.appendChild(d);
    box.classList.remove('hidden');
    return;
  }
  if (!HAS_WEBCODECS) {
    notes.push({ kind: 'warn', text: 'This browser lacks WebCodecs. Quick (keyframe) cuts and container conversion still work, but Precise cuts and anything that needs re-encoding will not. Chrome, Edge or a recent Safari/Firefox are recommended.' });
  }
  if (!FSA) {
    notes.push({ kind: 'warn', text: 'This browser cannot stream output straight to disk, so results are built in memory and then downloaded. Short clips are fine; converting or trimming very large files may run out of memory. Chrome or Edge avoid this.' });
  }
  box.innerHTML = '';
  for (const n of notes) {
    const d = document.createElement('div');
    d.className = `note ${n.kind}`;
    d.textContent = n.text;
    box.appendChild(d);
  }
  box.classList.toggle('hidden', notes.length === 0);
}

// ---------- File loading ----------

async function loadFile(file) {
  if (!file) return;
  if (state.running) return;
  await resetState();
  state.file = file;
  setStatus('Reading file…');

  let e;
  try {
    e = await probeFile(file);
  } catch (err) {
    console.error(err);
    setStatus(`Could not read this file: ${err.message || err}`, 'err');
    return;
  }
  const { file: _f, ...fields } = e;
  Object.assign(state, fields);
  state.packetSink = state.videoTrack ? new MB.EncodedPacketSink(state.videoTrack) : null;

  state.inPoint = 0;
  state.outPoint = state.duration;
  state.trimAmount = 0;

  renderFileInfo();
  populateResolution();
  $('#btnPrevKey').disabled = $('#btnNextKey').disabled = !state.packetSink;
  $('#btnSnap').disabled = !state.videoTrack;
  $('#timeTotal').textContent = fmtTime(state.duration);
  $('#scrub').max = String(state.duration);
  $('#dropzone').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  $('#openAnother').classList.remove('hidden');
  setStatus('');

  await setupPreview(file);
  syncTimeInputs();
  updateTimeline();
  renderJoin();
  refreshPlan();
}

// Opens a file with the media engine and gathers what the UI needs to know about it.
async function probeFile(file) {
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(file) });
  try {
    if (!(await input.canRead())) throw new Error('Unrecognized container format.');
    const format = await input.getFormat();
    const e = {
      file, input,
      formatName: format.name,
      formatKey: formatKeyFromMime(format.mimeType),
      duration: await input.computeDuration(),
      firstTs: await input.getFirstTimestamp(),
      videoTrack: await input.getPrimaryVideoTrack(),
      audioTrack: await input.getPrimaryAudioTrack(),
      videoCodec: null, width: 0, height: 0, codedW: 0, codedH: 0, desc: '', fps: 0, bitrate: 0,
      audioCodec: null, channels: 0, sampleRate: 0,
    };
    if (e.videoTrack) {
      const vt = e.videoTrack;
      e.videoCodec = await vt.getCodec();
      e.width = await vt.getDisplayWidth();
      e.height = await vt.getDisplayHeight();
      e.codedW = await vt.getCodedWidth();
      e.codedH = await vt.getCodedHeight();
      e.desc = decoderKey(await vt.getDecoderConfig());
      const stats = await vt.computePacketStats(1500);
      e.fps = stats.averagePacketRate || 0;
      e.bitrate = stats.averageBitrate || 0;
    }
    if (e.audioTrack) {
      const at = e.audioTrack;
      e.audioCodec = await at.getCodec();
      e.channels = await at.getNumberOfChannels();
      e.sampleRate = await at.getSampleRate();
    }
    return e;
  } catch (err) {
    try { input.dispose?.(); } catch (_) { /* ignore */ }
    throw err;
  }
}

function decoderKey(dc) {
  if (!dc) return '';
  let d = '';
  if (dc.description) {
    const u = dc.description instanceof ArrayBuffer ? new Uint8Array(dc.description) : new Uint8Array(dc.description.buffer, dc.description.byteOffset, dc.description.byteLength);
    d = Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${dc.codec}|${d}`;
}

function formatKeyFromMime(mime) {
  if (!mime) return null;
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('quicktime')) return 'mov';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('matroska')) return 'mkv';
  return null;
}

async function resetState() {
  if (state.conversion && state.running) {
    try { await state.conversion.cancel(); } catch (_) {}
  }
  if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
  const player = $('#player');
  player.pause();
  player.removeAttribute('src');
  player.load();
  try { state.input?.dispose?.(); } catch (_) {}
  for (const e of state.extra) { try { e.input?.dispose?.(); } catch (_) { /* ignore */ } }
  Object.assign(state, {
    file: null, input: null, duration: 0, firstTs: 0, formatKey: null, formatName: '',
    videoTrack: null, audioTrack: null, videoCodec: null, audioCodec: null, width: 0, height: 0, fps: 0, bitrate: 0,
    channels: 0, sampleRate: 0, packetSink: null, canvasSink: null, snapSink: null, previewMode: 'video',
    codedW: 0, codedH: 0, desc: '',
    inPoint: 0, outPoint: 0, trimAmount: 0, cutFrom: 0, cutTo: 0, cuts: [], extra: [], segJob: null,
    keyframe: { prev: null, next: null, for: null }, plan: null, conversion: null, running: false,
  });
  $('#cutList').innerHTML = '';
  $('#joinList').innerHTML = '';
  $('#frameCanvas').classList.add('hidden');
  player.classList.remove('hidden');
  const playBtn = $('#btnPlay');
  playBtn.disabled = false;
  $('#btnPrevKey').disabled = $('#btnNextKey').disabled = false;
  playBtn.textContent = 'Play';
  playBtn.title = 'Play / pause (Space)';
  setProgress(null);
}

function renderFileInfo() {
  const parts = [];
  parts.push(`<span><b>${escapeHtml(state.file.name)}</b> · ${fmtBytes(state.file.size)}</span>`);
  parts.push(`<span>${escapeHtml(state.formatName)}</span>`);
  parts.push(`<span>${fmtTime(state.duration)}</span>`);
  if (state.videoTrack) {
    const fps = state.fps ? ` · ${state.fps.toFixed(state.fps % 1 ? 2 : 0)} fps` : '';
    const br = state.bitrate ? ` · ${(state.bitrate / 1e6).toFixed(1)} Mb/s` : '';
    parts.push(`<span>Video: ${codecName(state.videoCodec)} ${state.width}×${state.height}${fps}${br}</span>`);
  } else {
    parts.push('<span>No video track</span>');
  }
  if (state.audioTrack) {
    parts.push(`<span>Audio: ${codecName(state.audioCodec)} ${state.channels}ch ${state.sampleRate ? Math.round(state.sampleRate / 100) / 10 + ' kHz' : ''}</span>`);
  } else {
    parts.push('<span>No audio track</span>');
  }
  $('#fileInfo').innerHTML = parts.join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Preview (video element, with canvas fallback) ----------

function setupPreview(file) {
  const player = $('#player');
  const canvas = $('#frameCanvas');
  state.previewMode = 'video';
  state.objectUrl = URL.createObjectURL(file);

  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };

    const onError = async () => {
      player.removeEventListener('error', onError);
      player.removeEventListener('loadedmetadata', onMeta);
      await enableCanvasPreview();
      done();
    };
    const onMeta = () => {
      player.removeEventListener('error', onError);
      player.removeEventListener('loadedmetadata', onMeta);
      // Some containers "load" but produce no picture (e.g. unsupported codec). Fall back if no video dimensions.
      if (state.videoTrack && (!player.videoWidth || !player.videoHeight)) {
        player.addEventListener('loadeddata', () => {
          if (!player.videoWidth) enableCanvasPreview().then(done); else done();
        }, { once: true });
        setTimeout(() => { if (!settled) { if (!player.videoWidth) enableCanvasPreview().then(done); else done(); } }, 2500);
      } else {
        done();
      }
    };
    player.addEventListener('error', onError);
    player.addEventListener('loadedmetadata', onMeta);
    player.src = state.objectUrl;
    canvas.classList.add('hidden');
    player.classList.remove('hidden');
  });
}

async function enableCanvasPreview() {
  const player = $('#player');
  const canvas = $('#frameCanvas');
  player.pause();
  player.removeAttribute('src');
  player.load();
  player.classList.add('hidden');
  canvas.classList.remove('hidden');
  state.previewMode = 'canvas';
  $('#btnPlay').disabled = true;
  $('#btnPlay').title = 'Playback is unavailable for this file in this browser; scrubbing still works.';
  if (!state.videoTrack || !(await state.videoTrack.canDecode())) {
    const ctx = canvas.getContext('2d');
    canvas.width = 640; canvas.height = 360;
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#aaa'; ctx.font = '16px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No preview available for this file (video codec cannot be decoded here).', canvas.width / 2, canvas.height / 2);
    return;
  }
  const maxW = 1280;
  const w = Math.min(maxW, state.width || maxW);
  state.canvasSink = new MB.CanvasSink(state.videoTrack, { width: w, poolSize: 2 });
  await drawFrame(currentTime());
}

let drawToken = 0;
async function drawFrame(t) {
  if (!state.canvasSink) return;
  const token = ++drawToken;
  try {
    const wrapped = await state.canvasSink.getCanvas(t);
    if (token !== drawToken || !wrapped) return;
    const canvas = $('#frameCanvas');
    const src = wrapped.canvas;
    if (canvas.width !== src.width || canvas.height !== src.height) { canvas.width = src.width; canvas.height = src.height; }
    canvas.getContext('2d').drawImage(src, 0, 0);
  } catch (err) {
    console.warn('Preview frame failed', err);
  }
}

let canvasTime = 0;
function currentTime() {
  return state.previewMode === 'video' ? ($('#player').currentTime || 0) : canvasTime;
}

function seekTo(t, { fromScrub = false } = {}) {
  t = clamp(t, 0, state.duration || 0);
  if (state.previewMode === 'video') {
    const p = $('#player');
    if (Math.abs(p.currentTime - t) > 1e-4) p.currentTime = t;
  } else {
    canvasTime = t;
    drawFrame(t);
  }
  if (!fromScrub) $('#scrub').value = String(t);
  $('#timeNow').textContent = fmtTime(t);
}

function frameStep() { return state.fps > 0 ? 1 / state.fps : 1 / 30; }

// The playhead time to use when setting a point. If a keyframe lies within half a frame of the playhead, return
// its exact timestamp so Quick mode treats the point as being on that keyframe rather than a hair before it.
async function playheadPoint() {
  const now = currentTime();
  if (!state.packetSink) return now;
  const half = frameStep() / 2;
  try {
    const p = await state.packetSink.getKeyPacket(now + half, { metadataOnly: true });
    if (p && Math.abs(p.timestamp - now) <= half) return p.timestamp;
  } catch (_) { /* fall through */ }
  return now;
}

// Move the playhead to the previous or next keyframe relative to its current position.
let keyJumpBusy = false;
async function jumpKeyframe(dir) {
  if (!state.packetSink || keyJumpBusy) return;
  keyJumpBusy = true;
  try {
    if (state.previewMode === 'video') $('#player').pause();
    const now = currentTime();
    const opts = { metadataOnly: true };
    // The player reports times that can sit a fraction of a millisecond either side of a frame's true timestamp,
    // so treat any keyframe within half a frame of the playhead as "the one we're on".
    const half = frameStep() / 2;
    let target = null;
    if (dir < 0) {
      const pkt = await state.packetSink.getKeyPacket(now - half, opts);
      target = pkt ? pkt.timestamp : 0;
    } else {
      const at = await state.packetSink.getKeyPacket(now + half, opts);
      const next = at ? await state.packetSink.getNextKeyPacket(at, opts) : await state.packetSink.getFirstKeyPacket(opts);
      if (next) target = next.timestamp;
    }
    if (target != null) seekTo(target);
  } catch (err) {
    console.warn('Keyframe jump failed', err);
  } finally {
    keyJumpBusy = false;
  }
}

function togglePlay() {
  if (state.previewMode !== 'video') return;
  const p = $('#player');
  if (p.paused) p.play().catch(() => {}); else p.pause();
}

// ---------- Timeline / in-out rendering ----------

function updateTimeline() {
  const d = state.duration || 1;
  const tab = state.tab;
  const tlIn = $('#tlIn'), tlOut = $('#tlOut'), tlRange = $('#tlRange');
  let a = 0, b = state.duration;
  if (tab === 'extract') { a = state.inPoint; b = state.outPoint; }
  else if (tab === 'trim') { a = state.trimAmount; }
  const pa = clamp(a / d, 0, 1) * 100, pb = clamp(b / d, 0, 1) * 100;
  tlIn.style.left = `${pa}%`;
  tlOut.style.left = `${pb}%`;
  tlRange.style.left = `${pa}%`;
  tlRange.style.width = `${Math.max(0, pb - pa)}%`;
  tlIn.classList.toggle('hidden', !(tab === 'extract' || tab === 'trim'));
  tlOut.classList.toggle('hidden', tab !== 'extract');
  const cuts = $('#tlCuts');
  cuts.innerHTML = '';
  if (tab === 'cutout') {
    for (const c of state.cuts) {
      const el = document.createElement('div');
      el.className = 'tl-cut';
      el.style.left = `${clamp(c.from / d, 0, 1) * 100}%`;
      el.style.width = `${clamp((c.to - c.from) / d, 0, 1) * 100}%`;
      cuts.appendChild(el);
    }
  }
}

function syncTimeInputs() {
  $('#inTime').value = fmtTime(state.inPoint);
  $('#outTime').value = fmtTime(state.outPoint);
  $('#trimTime').value = fmtTime(state.trimAmount);
  $('#cutFrom').value = fmtTime(state.cutFrom);
  $('#cutTo').value = fmtTime(state.cutTo);
  const len = state.outPoint - state.inPoint;
  $('#clipLength').textContent = len > 0 ? `Clip length: ${fmtTime(len)}` : 'Out must be after In.';
  const keep = state.duration - state.trimAmount;
  $('#trimSummary').textContent = keep > 0
    ? `Keeps ${fmtTime(state.trimAmount)} → end (${fmtTime(keep)} remains).`
    : 'That would remove the whole video.';
}

// ---------- Keyframe lookup (for Quick mode) ----------

let kfToken = 0;
async function refreshKeyframeInfo() {
  const info = $('#keyframeInfo');
  const quick = cutMode() === 'quick';
  if (state.tab !== 'extract' && state.tab !== 'trim') { info.innerHTML = ''; return; }
  if (!quick || !hasVideoOut()) { info.innerHTML = ''; return; }
  if (!state.packetSink) { info.innerHTML = ''; return; }
  const start = activeStart();
  const token = ++kfToken;
  try {
    const opts = { metadataOnly: true };
    const prev = await state.packetSink.getKeyPacket(start, opts);
    const next = prev ? await state.packetSink.getNextKeyPacket(prev, opts) : await state.packetSink.getFirstKeyPacket(opts);
    if (token !== kfToken) return;
    state.keyframe = { prev: prev ? prev.timestamp : null, next: next ? next.timestamp : null, for: start };
    const p = state.keyframe.prev, n = state.keyframe.next;
    const parts = [];
    if (p != null) {
      const diff = start - p;
      parts.push(diff < 0.0005
        ? `<span class="ok">Start is on a keyframe (${fmtTime(p)}).</span>`
        : `Cut will start at keyframe <b>${fmtTime(p)}</b> (${diff.toFixed(2)} s earlier).`);
    } else {
      parts.push('Cut will start at the beginning.');
    }
    const btns = [];
    if (p != null && start - p > 0.0005) btns.push(`<button type="button" class="small" data-kf="${p}">◀ snap to ${fmtTime(p, { ms: false })}</button>`);
    if (n != null) btns.push(`<button type="button" class="small" data-kf="${n}">next keyframe ${fmtTime(n, { ms: false })} ▶</button>`);
    info.innerHTML = parts.join(' ') + (btns.length ? ' ' + btns.join('') : '');
  } catch (err) {
    console.warn('Keyframe lookup failed', err);
    if (token === kfToken) info.innerHTML = '<span class="warn">Could not inspect keyframes; the cut will snap to the nearest earlier keyframe automatically.</span>';
  }
}

function activeStart() {
  return state.tab === 'extract' ? state.inPoint : state.tab === 'trim' ? state.trimAmount : 0;
}
function setActiveStart(t) {
  if (state.tab === 'extract') state.inPoint = clamp(t, 0, state.duration);
  else if (state.tab === 'trim') state.trimAmount = clamp(t, 0, state.duration);
  syncTimeInputs();
  updateTimeline();
  refreshPlan();
}

function cutMode() { return $('input[name=cutMode]:checked').value; }

// ---------- Cut out: list of removed ranges ----------

function addCut() {
  const from = state.cutFrom, to = state.cutTo;
  if (!(to > from)) { setStatus('The cut needs an end later than its start.', 'err'); return; }
  state.cuts.push({ from, to });
  normalizeCuts();
  setStatus('');
  updateTimeline();
  refreshPlan();
}

function normalizeCuts() {
  const d = state.duration;
  const cs = state.cuts
    .map((c) => ({ from: clamp(c.from, 0, d), to: clamp(c.to, 0, d) }))
    .filter((c) => c.to > c.from)
    .sort((a, b) => a.from - b.from);
  const merged = [];
  for (const c of cs) {
    const last = merged[merged.length - 1];
    if (last && c.from <= last.to) last.to = Math.max(last.to, c.to);
    else merged.push({ ...c });
  }
  state.cuts = merged;
}

// The pieces that remain once the cuts are removed, over [0, duration].
function keptSegments() {
  const segs = [];
  let pos = 0;
  for (const c of state.cuts) {
    if (c.from > pos) segs.push({ start: pos, end: c.from });
    pos = Math.max(pos, c.to);
  }
  if (state.duration > pos) segs.push({ start: pos, end: state.duration });
  return segs;
}

let cutsToken = 0;
async function renderCuts() {
  const ul = $('#cutList');
  ul.innerHTML = '';
  const token = ++cutsToken;
  state.cuts.forEach((c, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="mono">${fmtTime(c.from)} → ${fmtTime(c.to)}</span><span class="dim">(${fmtTime(c.to - c.from)})</span><span class="grow"></span>`
      + `<button type="button" data-cut-go="${i}" title="Jump to the start of this cut">Go</button>`
      + `<button type="button" data-cut-del="${i}" title="Remove this cut from the list">×</button>`
      + `<span class="sub" data-cut-sub="${i}"></span>`;
    ul.appendChild(li);
  });
  const el = $('#cutSummary');
  if (!state.cuts.length) {
    el.textContent = 'Mark a section to remove and click Add cut. Everything else is kept and joined into one file.';
  } else {
    const removed = state.cuts.reduce((a, c) => a + (c.to - c.from), 0);
    el.textContent = `Removes ${state.cuts.length} section${state.cuts.length > 1 ? 's' : ''} (${fmtTime(removed)}); the result will be about ${fmtTime(state.duration - removed)} long.`;
  }
  // In Quick mode the video after each cut resumes at a keyframe; say where.
  if (!(hasVideoOut() && cutMode() === 'quick' && state.videoTrack)) return;
  for (let i = 0; i < state.cuts.length; i++) {
    const c = state.cuts[i];
    let kf;
    try { kf = await window.EzSegments.keyframeBefore(state.videoTrack, c.to); } catch (_) { continue; }
    if (token !== cutsToken) return;
    const sub = ul.querySelector(`[data-cut-sub="${i}"]`);
    if (!sub) continue;
    if (c.to >= state.duration - 1e-6) sub.textContent = '';
    else if (kf <= c.from + 1e-6) { sub.textContent = 'Quick mode: no keyframe inside this cut, so nothing would be removed. Make it longer or use Precise mode.'; sub.classList.add('warn'); }
    else if (c.to - kf > 0.0005) sub.textContent = `Quick mode: video resumes at keyframe ${fmtTime(kf)}, so ${fmtTime(c.to - kf)} less is removed.`;
    else sub.textContent = '';
  }
}

// ---------- Join: ordered list of files ----------

function joinEntries() {
  const main = {
    file: state.file, input: state.input, duration: state.duration, firstTs: state.firstTs,
    videoTrack: state.videoTrack, audioTrack: state.audioTrack, videoCodec: state.videoCodec, width: state.width, height: state.height,
    codedW: state.codedW, codedH: state.codedH, desc: state.desc, audioCodec: state.audioCodec, channels: state.channels, sampleRate: state.sampleRate,
  };
  return [main, ...state.extra];
}

async function addExtraFiles(files) {
  if (!state.input || state.running) return;
  for (const f of files) {
    setStatus(`Reading ${f.name}…`);
    try { state.extra.push(await probeFile(f)); }
    catch (err) { console.error(err); setStatus(`Could not read ${f.name}: ${err.message || err}`, 'err'); continue; }
    setStatus('');
  }
  renderJoin();
  refreshPlan();
}

function renderJoin() {
  const ol = $('#joinList');
  ol.innerHTML = '';
  if (!state.input) return;
  const entries = joinEntries();
  entries.forEach((e, i) => {
    const li = document.createElement('li');
    const v = e.videoTrack ? `${codecName(e.videoCodec)} ${e.width}×${e.height}` : 'no video';
    const a = e.audioTrack ? `${codecName(e.audioCodec)} ${e.channels}ch` : 'no audio';
    li.innerHTML = `<span class="mono dim">${i + 1}.</span><span class="grow"><b>${escapeHtml(e.file.name)}</b> <span class="dim">· ${fmtTime(e.duration)} · ${v} · ${a}</span></span>`
      + (i === 0 ? '<span class="dim">loaded above</span>'
        : `<button type="button" data-join-up="${i}" title="Move up"${i === 1 ? ' disabled' : ''}>▲</button>`
          + `<button type="button" data-join-down="${i}" title="Move down"${i === entries.length - 1 ? ' disabled' : ''}>▼</button>`
          + `<button type="button" data-join-del="${i}" title="Remove from the list">×</button>`);
    ol.appendChild(li);
  });
  const total = entries.reduce((sum, e) => sum + e.duration, 0);
  $('#joinSummary').textContent = entries.length < 2 ? 'Add at least one more file.' : `${entries.length} files, ${fmtTime(total)} in total.`;
}

function joinCompat(entries) {
  const f = entries[0];
  const problems = [];
  for (const e of entries.slice(1)) {
    if (!!e.videoTrack !== !!f.videoTrack) problems.push(`${e.file.name} ${e.videoTrack ? 'has' : 'has no'} video track, unlike the first file.`);
    if (!!e.audioTrack !== !!f.audioTrack) problems.push(`${e.file.name} ${e.audioTrack ? 'has' : 'has no'} audio track, unlike the first file.`);
  }
  const videoSame = entries.every((e) => e.videoCodec === f.videoCodec && e.codedW === f.codedW && e.codedH === f.codedH && e.desc === f.desc);
  const audioSame = entries.every((e) => e.audioCodec === f.audioCodec && e.channels === f.channels && e.sampleRate === f.sampleRate);
  return { problems, videoSame, audioSame };
}

// ---------- Plan (what will be copied vs re-encoded) ----------

let planToken = 0;

function audioMode() { return $('#audioMode').value; }
function hasVideoOut() { return !!state.videoTrack && audioMode() !== 'only'; }
function hasAudioOut() { return !!state.audioTrack && audioMode() !== 'remove'; }
function resolutionChoice() { const v = $('#resolution').value; return v === 'keep' ? null : Number(v); }
function isPrecise() { return hasVideoOut() && state.tab !== 'convert' && cutMode() === 'precise'; }

// The format dropdown lists video containers normally and audio containers in "audio only" mode.
function applyFormatOptions() {
  const sel = $('#outFormat');
  const only = audioMode() === 'only';
  const keys = only ? AUDIO_FORMAT_KEYS : ['same', ...VIDEO_FORMAT_KEYS];
  sel.innerHTML = '';
  for (const k of keys) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = k === 'same' ? 'Same as source' : FORMATS[k].label;
    sel.appendChild(o);
  }
  const wanted = only ? state.audioFormat : state.videoFormat;
  sel.value = keys.includes(wanted) ? wanted : keys[0];
}

// Offer only resolutions smaller than the source (measured on the short side, so portrait video works too).
function populateResolution() {
  const sel = $('#resolution');
  sel.innerHTML = '<option value="keep">Keep</option>';
  if (state.videoTrack) {
    const short = Math.min(state.width, state.height);
    for (const r of RESOLUTIONS.filter((r) => r < short)) {
      const o = document.createElement('option');
      o.value = String(r);
      o.textContent = `${r}p`;
      sel.appendChild(o);
    }
  }
  sel.value = Array.from(sel.options).some((o) => o.value === state.savedResolution) ? state.savedResolution : 'keep';
}

async function refreshPlan() {
  refreshKeyframeInfo();
  const token = ++planToken;
  const note = $('#planNote');
  const go = $('#btnGo');
  if (!state.input) return;

  const only = audioMode() === 'only';
  const fmtKey = resolveFormatKey();
  const fmt = FORMATS[fmtKey];
  const of = fmt.make();
  const videoOut = hasVideoOut();
  const audioOut = hasAudioOut();
  const precise = isPrecise();
  const resizable = videoOut && (precise || state.tab === 'convert');
  const resize = resizable ? resolutionChoice() : null;
  const plan = { fmtKey, fmt, video: null, audio: null, errors: [], precise, resize, only };

  $('#cutModeBox').classList.toggle('hidden', state.tab === 'convert' || !videoOut);
  if (state.tab === 'cutout') renderCuts();
  $('#resolutionRow').classList.toggle('hidden', !(resizable && $('#resolution').options.length > 1));

  // Video
  if (videoOut) {
    const supported = of.getSupportedVideoCodecs();
    const canHold = state.videoCodec != null && supported.includes(state.videoCodec);
    const mustEncode = precise || resize != null;
    if (!mustEncode && canHold) {
      plan.video = { action: 'copy' };
    } else if (!mustEncode && state.tab !== 'convert') {
      plan.errors.push(state.videoCodec == null
        ? 'The video codec is not recognized, so it cannot be copied. Try Precise mode.'
        : `${fmt.label} cannot hold ${codecName(state.videoCodec)} video, so a Quick cut is not possible. Choose another format or use Precise mode.`);
    } else if (!HAS_WEBCODECS) {
      plan.errors.push('Re-encoding needs WebCodecs, which this browser lacks.');
    } else if (!(await state.videoTrack.canDecode())) {
      plan.errors.push(`This browser cannot decode ${codecName(state.videoCodec)} video, so it cannot re-encode it.`);
    } else {
      const encOpts = { width: state.width, height: state.height };
      let codec = null;
      if (canHold && (await MB.canEncodeVideo(state.videoCodec, encOpts))) codec = state.videoCodec;
      else codec = await MB.getFirstEncodableVideoCodec(supported, encOpts);
      if (!codec) {
        plan.errors.push(`This browser cannot encode any video codec that ${fmt.label} supports.`);
      } else {
        const reasons = [];
        if (precise) reasons.push('frame-accurate cut');
        if (resize != null) reasons.push(`resized to ${resize}p`);
        if (!canHold) reasons.push(`${fmt.label} cannot hold ${codecName(state.videoCodec)}`);
        plan.video = { action: 'encode', codec, reason: reasons.join(', ') };
      }
    }
  }

  // Audio
  const segTab = state.tab === 'cutout' || state.tab === 'join';
  const compat = state.tab === 'join' ? joinCompat(joinEntries()) : null;
  if (audioOut) {
    const supported = of.getSupportedAudioCodecs();
    const canHold = state.audioCodec != null && supported.includes(state.audioCodec);
    const mustEncode = compat ? !compat.audioSame : false;
    if (canHold && !mustEncode) {
      plan.audio = { action: 'copy' };
    } else {
      const aOpts = { numberOfChannels: state.channels, sampleRate: state.sampleRate };
      const candidates = (AUDIO_FALLBACK[fmtKey] || []).filter((c) => supported.includes(c)).concat(supported);
      let codec = null;
      try { codec = await MB.getFirstEncodableAudioCodec(candidates, aOpts); } catch (_) { codec = null; }
      if (!codec) plan.errors.push(`This browser cannot encode any audio codec that ${fmt.label} supports.`);
      else plan.audio = { action: 'encode', codec, reason: mustEncode ? 'the files differ in audio format' : `${fmt.label} cannot hold ${codecName(state.audioCodec)}` };
    }
  }

  // Segment tabs
  if (state.tab === 'cutout') {
    if (!state.cuts.length) plan.errors.push('Add at least one cut.');
    else if (!keptSegments().length) plan.errors.push('The cuts remove the whole video.');
  }
  if (state.tab === 'join') {
    const entries = joinEntries();
    if (entries.length < 2) plan.errors.push('Add at least one more file to join.');
    plan.errors.push(...compat.problems);
    if (videoOut && !precise && !compat.videoSame && entries.length >= 2) plan.errors.push('The files differ in video codec, size or encoding settings, so Quick mode cannot join them. Switch to Precise mode.');
  }
  if (segTab && plan.video && plan.video.action === 'encode' && plan.video.reason.includes('frame-accurate cut') && state.tab === 'join') {
    plan.video.reason = plan.video.reason.replace('frame-accurate cut', 'Precise join');
  }

  if (!state.videoTrack && !state.audioTrack) plan.errors.push('No video or audio track was found in this file.');
  if (only && !state.audioTrack) plan.errors.push('This file has no audio track.');
  if (!only && !videoOut && !audioOut) plan.errors.push('Nothing would be left in the output.');

  // Range sanity
  if (state.tab === 'extract' && state.outPoint - state.inPoint <= 0) plan.errors.push('Out must be after In.');
  if (state.tab === 'trim' && state.duration - state.trimAmount <= 0) plan.errors.push('Nothing would be left after trimming.');

  if (token !== planToken) return;
  state.plan = plan;

  const lines = [];
  if (plan.video) lines.push(plan.video.action === 'copy'
    ? `Video: ${codecName(state.videoCodec)} copied (lossless).`
    : `Video: re-encoded to ${codecName(plan.video.codec)} (${plan.video.reason}).`);
  else if (state.videoTrack) lines.push('Video: removed.');
  if (plan.audio) lines.push(plan.audio.action === 'copy'
    ? `Audio: ${codecName(state.audioCodec)} copied.`
    : `Audio: re-encoded to ${codecName(plan.audio.codec)} (${plan.audio.reason}).`);
  else if (state.audioTrack) lines.push('Audio: removed.');
  for (const e of plan.errors) lines.push(`<span class="err">${escapeHtml(e)}</span>`);
  note.innerHTML = lines.map(escapeUnlessMarkup).join('<br>');

  $('#qualityRow').classList.toggle('hidden', !(plan.video && plan.video.action === 'encode'));
  go.disabled = plan.errors.length > 0 || state.running;
  const what = only ? 'audio' : state.tab === 'extract' ? 'clip' : 'video';
  go.textContent = state.tab === 'extract' ? `Save ${what}…`
    : state.tab === 'trim' ? `Save trimmed ${what}…`
    : state.tab === 'cutout' ? `Save edited ${what}…`
    : state.tab === 'join' ? `Save joined ${what}…`
    : `Save as ${fmt.label.split(' ')[0]}…`;
}

function escapeUnlessMarkup(s) { return s.startsWith('<span') ? s : escapeHtml(s); }

function resolveFormatKey() {
  const v = $('#outFormat').value;
  if (audioMode() === 'only') return AUDIO_FORMAT_KEYS.includes(v) ? v : 'm4a';
  if (v !== 'same') return v;
  return state.formatKey || 'mp4';
}

// ---------- Running a job ----------

async function runJob() {
  if (state.running || !state.input || !state.plan || state.plan.errors.length) return;
  const plan = state.plan;
  const fmt = plan.fmt;
  const videoOut = hasVideoOut();
  const audioOut = hasAudioOut();

  // Work out the trim range.
  let start, end;
  if (state.tab === 'extract') { start = state.inPoint; end = state.outPoint; }
  else if (state.tab === 'trim') { start = state.trimAmount; end = undefined; }
  else { start = undefined; end = undefined; }

  let snappedNote = '';
  if (start != null && videoOut && !plan.precise && state.packetSink) {
    // Quick mode: snap the start to the keyframe at or before the requested point.
    const kf = state.keyframe.for === start ? state.keyframe.prev : (await state.packetSink.getKeyPacket(start, { metadataOnly: true }))?.timestamp ?? null;
    if (kf != null && kf < start) { snappedNote = ` (start snapped to keyframe at ${fmtTime(kf)})`; start = kf; }
  }
  if (start != null && start <= Math.max(0, state.firstTs)) start = undefined;
  if (end != null && end >= state.duration) end = undefined;

  // Output name.
  const base = state.file.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
  const suffixes = [];
  if (state.tab === 'extract') suffixes.push(`clip_${fmtTime(state.inPoint, { ms: false }).replace(/:/g, '.')}-${fmtTime(state.outPoint, { ms: false }).replace(/:/g, '.')}`);
  else if (state.tab === 'trim') suffixes.push('trimmed');
  else if (state.tab === 'cutout') suffixes.push('cut');
  else if (state.tab === 'join') suffixes.push('joined');
  if (plan.only) suffixes.push('audio');
  else if (!audioOut && state.audioTrack) suffixes.push('silent');
  if (plan.resize != null) suffixes.push(`${plan.resize}p`);
  if (!suffixes.length && plan.fmtKey === state.formatKey) suffixes.push('converted');
  const suggested = [base, ...suffixes].join('_') + fmt.ext;

  // Get a destination first, while we still have the user's click.
  let sink;
  try {
    sink = await openOutput(suggested, fmt);
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user cancelled the save dialog
    console.error(err);
    setStatus(`Could not open the output file: ${err.message || err}`, 'err');
    return;
  }
  if (!sink) return;

  if (state.tab === 'cutout' || state.tab === 'join') {
    await runSegmentJob(plan, sink, fmt, videoOut, audioOut);
    return;
  }

  // Build the conversion.
  const video = {};
  const audio = {};
  if (state.videoTrack && !videoOut) video.discard = true;
  if (state.audioTrack && !audioOut) audio.discard = true;
  if (plan.video && plan.video.action === 'encode') {
    video.forceTranscode = true;
    video.codec = plan.video.codec;
    Object.assign(video, qualityOptions());
    if (plan.resize != null) {
      // Scale the short side; the other side follows the aspect ratio.
      if (state.width >= state.height) video.height = plan.resize; else video.width = plan.resize;
    }
  }
  if (plan.audio && plan.audio.action === 'encode') audio.codec = plan.audio.codec;

  const everythingCopies = (!plan.video || plan.video.action === 'copy') && (!plan.audio || plan.audio.action === 'copy');
  const copy = everythingCopies ? { mode: 'forced' } : {};

  const output = new MB.Output({ format: fmt.make(), target: sink.target });
  const trim = {};
  if (start != null) trim.start = start;
  if (end != null) trim.end = end;

  setRunning(true);
  setStatus('Preparing…');
  setProgress(0);
  const t0 = performance.now();
  let conversion;
  try {
    conversion = await MB.Conversion.init({ input: state.input, output, trim, video, audio, copy, showWarnings: false });
    state.conversion = conversion;

    const dropped = conversion.discardedTracks.filter((d) =>
      (d.track === state.videoTrack && videoOut) || (d.track === state.audioTrack && audioOut));
    if (dropped.length) {
      const why = dropped.map((d) => `${d.track.type} (${d.reason.replace(/_/g, ' ')})`).join(', ');
      throw new Error(`Cannot produce this output; the engine would drop: ${why}. ${everythingCopies ? 'Try Precise mode or a different format.' : ''}`);
    }
    if (!conversion.isValid) throw new Error('The engine reports this conversion is not possible with the chosen settings.');

    const total = (end ?? state.duration) - (start ?? Math.max(0, state.firstTs));
    conversion.onProgress = (p, processed) => {
      setProgress(p);
      const elapsed = (performance.now() - t0) / 1000;
      const speed = elapsed > 0.5 && processed > 0 ? ` · ${(processed / elapsed).toFixed(1)}× realtime` : '';
      const eta = p > 0.02 && p < 1 ? ` · about ${fmtTime((elapsed / p) * (1 - p), { ms: false })} left` : '';
      setStatus(`${Math.round(p * 100)}% · ${fmtTime(processed, { ms: false })} of ${fmtTime(total, { ms: false })}${speed}${eta}`);
    };

    await conversion.execute();
    await sink.finish();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    setProgress(1);
    setStatus(`Done in ${secs} s → ${sink.name}${snappedNote}`, 'ok');
  } catch (err) {
    if (err instanceof MB.ConversionCanceledError || (err && err.name === 'ConversionCanceledError')) {
      setStatus('Cancelled. A partial output file may have been left behind.', '');
    } else {
      console.error(err);
      setStatus(`Failed: ${err.message || err}`, 'err');
      try { await conversion?.cancel?.(); } catch (_) {}
    }
    try { await sink.abort(); } catch (_) {}
    setProgress(null);
  } finally {
    state.conversion = null;
    setRunning(false);
  }
}

// Cut out / Join: drive the segment engine (segments.js) instead of a single Conversion.
async function runSegmentJob(plan, sink, fmt, videoOut, audioOut) {
  let segments;
  if (state.tab === 'join') {
    segments = joinEntries().map((e) => ({ input: e.input, videoTrack: e.videoTrack, audioTrack: e.audioTrack, start: Math.max(0, e.firstTs), end: e.duration }));
  } else {
    segments = keptSegments().map((sg) => ({ input: state.input, videoTrack: state.videoTrack, audioTrack: state.audioTrack, start: sg.start, end: sg.end }));
  }
  const videoEncoding = plan.video && plan.video.action === 'encode'
    ? { codec: plan.video.codec, ...qualityOptions(), ...(plan.resize != null ? { transform: state.width >= state.height ? { height: plan.resize } : { width: plan.resize } } : {}) }
    : null;
  const audioEncoding = plan.audio && plan.audio.action === 'encode' ? { codec: plan.audio.codec, quality: new MB.Quality('high') } : null;

  const output = new MB.Output({ format: fmt.make(), target: sink.target });
  const signal = { cancelled: false };
  state.segJob = { signal, output };
  setRunning(true);
  setStatus('Preparing…');
  setProgress(0);
  const t0 = performance.now();
  const total = segments.reduce((a, sg) => a + Math.max(0, sg.end - sg.start), 0);
  try {
    const res = await window.EzSegments.run(segments, {
      output, videoOut, audioOut,
      videoMode: videoEncoding ? 'encode' : 'copy', videoEncoding,
      audioMode: audioEncoding ? 'encode' : 'copy', audioEncoding,
      signal,
      onProgress: (p, processed) => {
        setProgress(p);
        const elapsed = (performance.now() - t0) / 1000;
        const speed = elapsed > 0.5 && processed > 0 ? ` · ${(processed / elapsed).toFixed(1)}× realtime` : '';
        const eta = p > 0.02 && p < 1 ? ` · about ${fmtTime((elapsed / p) * (1 - p), { ms: false })} left` : '';
        setStatus(`${Math.round(p * 100)}% · ${fmtTime(processed, { ms: false })} of ${fmtTime(total, { ms: false })}${speed}${eta}`);
      },
    });
    await sink.finish();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    setProgress(1);
    setStatus(`Done in ${secs} s → ${sink.name} (${fmtTime(res.duration)} long)`, 'ok');
  } catch (err) {
    if (signal.cancelled || (err && err.name === 'SegmentsCanceledError')) {
      setStatus('Cancelled. A partial output file may have been left behind.', '');
    } else {
      console.error(err);
      setStatus(`Failed: ${err.message || err}`, 'err');
    }
    try { await output.cancel(); } catch (_) { /* ignore */ }
    try { await sink.abort(); } catch (_) { /* ignore */ }
    setProgress(null);
  } finally {
    state.segJob = null;
    setRunning(false);
  }
}

function qualityOptions() {
  const q = $('#quality').value;
  if (q === 'source') {
    if (state.bitrate > 0) return { bitrate: Math.round(state.bitrate) };
    return { quality: new MB.Quality('high') };
  }
  return { quality: new MB.Quality(q) };
}

async function openOutput(suggestedName, fmt) {
  if (FSA) {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: `${fmt.label} video`, accept: { [fmt.mime]: [fmt.ext] } }],
    });
    const writable = await handle.createWritable();
    return {
      target: new MB.StreamTarget(writable, { chunked: true }),
      name: handle.name,
      finish: async () => {},
      abort: async () => { try { await writable.abort(); } catch (_) {} },
    };
  }
  const target = new MB.BufferTarget();
  return {
    target,
    name: suggestedName,
    finish: async () => {
      const blob = new Blob([target.buffer], { type: fmt.mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = suggestedName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    abort: async () => {},
  };
}

function setRunning(on) {
  state.running = on;
  $('#btnGo').disabled = on || !state.plan || state.plan.errors.length > 0;
  $('#btnCancel').classList.toggle('hidden', !on);
  $('#openAnother').disabled = on;
  $$('.tabs button, .options input, .options select, .options button, .panel input, .panel button, #btnSnap').forEach((el) => { el.disabled = on; });
}

function setProgress(p) {
  const wrap = $('#progressWrap');
  if (p == null) { wrap.classList.add('hidden'); $('#progressBar').style.width = '0%'; return; }
  wrap.classList.remove('hidden');
  $('#progressBar').style.width = `${Math.round(clamp(p, 0, 1) * 100)}%`;
}

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

// ---------- Snapshot (save the current frame as PNG) ----------

async function saveSnapshot() {
  if (!state.videoTrack || state.running) return;
  const t = currentTime();
  const base = state.file.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
  const suggested = `${base}_${fmtTime(t).replace(/:/g, '.')}.png`;

  // Ask where to save first, while the click still counts as a user gesture.
  let handle = null;
  if (FSA) {
    try {
      handle = await window.showSaveFilePicker({ suggestedName: suggested, types: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }] });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      setStatus(`Could not open the output file: ${err.message || err}`, 'err');
      return;
    }
  }

  setStatus('Decoding frame…');
  try {
    let canvas = null;
    if (await state.videoTrack.canDecode()) {
      state.snapSink ??= new MB.CanvasSink(state.videoTrack, { poolSize: 1 });
      const wrapped = await state.snapSink.getCanvas(t);
      canvas = wrapped ? wrapped.canvas : null;
    }
    if (!canvas && state.previewMode === 'video') {
      const v = $('#player');
      if (v.videoWidth) {
        canvas = document.createElement('canvas');
        canvas.width = v.videoWidth; canvas.height = v.videoHeight;
        canvas.getContext('2d').drawImage(v, 0, 0);
      }
    }
    if (!canvas) throw new Error('could not decode a frame at this position.');
    const blob = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode PNG'))), 'image/png'));
    if (handle) {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = suggested;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    setStatus(`Saved frame at ${fmtTime(t)} (${canvas.width}×${canvas.height}) → ${handle ? handle.name : suggested}`, 'ok');
  } catch (err) {
    console.error(err);
    setStatus(`Snapshot failed: ${err.message || err}`, 'err');
  }
}

// ---------- Remembered settings ----------

const SETTINGS_KEY = 'ezvid.settings';

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (_) { return {}; }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      cutMode: cutMode(),
      quality: $('#quality').value,
      audioMode: audioMode(),
      videoFormat: state.videoFormat,
      audioFormat: state.audioFormat,
      resolution: $('#resolution').value,
    }));
  } catch (_) { /* storage unavailable; nothing to do */ }
}

function restoreSettings() {
  const s = loadSettings();
  const setSelect = (id, v) => { const el = $(id); if (v != null && Array.from(el.options).some((o) => o.value === v)) el.value = v; };
  setSelect('#audioMode', s.audioMode);
  setSelect('#quality', s.quality);
  if (s.cutMode === 'quick' || s.cutMode === 'precise') $(`input[name=cutMode][value=${s.cutMode}]`).checked = true;
  if (VIDEO_FORMAT_KEYS.includes(s.videoFormat) || s.videoFormat === 'same') state.videoFormat = s.videoFormat;
  if (AUDIO_FORMAT_KEYS.includes(s.audioFormat)) state.audioFormat = s.audioFormat;
  if (s.resolution === 'keep' || RESOLUTIONS.includes(Number(s.resolution))) state.savedResolution = String(s.resolution);
  applyFormatOptions();
}

// ---------- Wiring ----------

function wire() {
  $('#version').textContent = `v${APP_VERSION}`;
  showCapabilityNotes();

  // File choosing
  const dz = $('#dropzone');
  const fileInput = $('#fileInput');
  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); fileInput.value = ''; });
  $('#openAnother').addEventListener('click', () => fileInput.click());

  for (const evt of ['dragenter', 'dragover']) {
    document.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.add('over'); });
  }
  document.addEventListener('dragleave', (e) => { if (e.target === document.documentElement || e.relatedTarget == null) dz.classList.remove('over'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFile(f);
  });

  // Player & transport
  const player = $('#player');
  const scrub = $('#scrub');
  let scrubbing = false;
  scrub.addEventListener('pointerdown', () => { scrubbing = true; });
  document.addEventListener('pointerup', () => { scrubbing = false; });
  document.addEventListener('pointercancel', () => { scrubbing = false; });
  const syncPlayhead = () => {
    if (!scrubbing) scrub.value = String(player.currentTime);
    $('#timeNow').textContent = fmtTime(player.currentTime);
  };
  player.addEventListener('timeupdate', syncPlayhead);
  player.addEventListener('seeked', syncPlayhead);
  let raf = 0;
  const tick = () => { syncPlayhead(); if (!player.paused) raf = requestAnimationFrame(tick); };
  player.addEventListener('play', () => { $('#btnPlay').textContent = 'Pause'; cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); });
  player.addEventListener('pause', () => { $('#btnPlay').textContent = 'Play'; cancelAnimationFrame(raf); syncPlayhead(); });
  player.addEventListener('click', togglePlay);
  scrub.addEventListener('input', () => { if (state.previewMode === 'video') player.pause(); seekTo(Number(scrub.value), { fromScrub: true }); });

  $('#btnPlay').addEventListener('click', togglePlay);
  $('#btnPrevKey').addEventListener('click', () => jumpKeyframe(-1));
  $('#btnNextKey').addEventListener('click', () => jumpKeyframe(1));
  $('#btnBackFrame').addEventListener('click', () => nudge(-frameStep()));
  $('#btnFwdFrame').addEventListener('click', () => nudge(frameStep()));

  // Tabs
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

  // In/Out/Trim inputs
  const bindTime = (id, apply) => {
    const el = $(id);
    const commit = () => {
      const t = parseTime(el.value);
      if (Number.isNaN(t)) { syncTimeInputs(); return; }
      apply(clamp(t, 0, state.duration));
      syncTimeInputs(); updateTimeline(); refreshPlan();
    };
    el.addEventListener('change', commit);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); el.blur(); } });
  };
  bindTime('#inTime', (t) => { state.inPoint = t; });
  bindTime('#outTime', (t) => { state.outPoint = t; });
  bindTime('#trimTime', (t) => { state.trimAmount = t; });
  bindTime('#cutFrom', (t) => { state.cutFrom = t; });
  bindTime('#cutTo', (t) => { state.cutTo = t; });

  const POINTS = { in: 'inPoint', out: 'outPoint', trim: 'trimAmount', cutFrom: 'cutFrom', cutTo: 'cutTo' };
  $$('[data-set]').forEach((b) => b.addEventListener('click', async () => {
    state[POINTS[b.dataset.set]] = await playheadPoint();
    syncTimeInputs(); updateTimeline(); refreshPlan();
  }));
  $$('[data-go]').forEach((b) => b.addEventListener('click', () => seekTo(state[POINTS[b.dataset.go]])));

  // Cut out
  $('#btnAddCut').addEventListener('click', addCut);
  $('#cutList').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || state.running) return;
    if (b.dataset.cutGo != null) seekTo(state.cuts[Number(b.dataset.cutGo)].from);
    if (b.dataset.cutDel != null) { state.cuts.splice(Number(b.dataset.cutDel), 1); updateTimeline(); refreshPlan(); }
  });

  // Join
  const joinInput = $('#joinInput');
  $('#btnAddFiles').addEventListener('click', () => joinInput.click());
  joinInput.addEventListener('change', () => { addExtraFiles(Array.from(joinInput.files)); joinInput.value = ''; });
  $('#joinList').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || state.running) return;
    const i = Number(b.dataset.joinUp ?? b.dataset.joinDown ?? b.dataset.joinDel) - 1; // index into state.extra
    if (b.dataset.joinDel != null) { try { state.extra[i].input?.dispose?.(); } catch (_) { /* ignore */ } state.extra.splice(i, 1); }
    else if (b.dataset.joinUp != null && i > 0) { [state.extra[i - 1], state.extra[i]] = [state.extra[i], state.extra[i - 1]]; }
    else if (b.dataset.joinDown != null && i < state.extra.length - 1) { [state.extra[i + 1], state.extra[i]] = [state.extra[i], state.extra[i + 1]]; }
    renderJoin(); refreshPlan();
  });

  // Keyframe snap buttons (rendered dynamically)
  $('#keyframeInfo').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kf]');
    if (!b) return;
    const t = Number(b.dataset.kf);
    setActiveStart(t);
    seekTo(t);
  });

  // Options
  const onSetting = () => { saveSettings(); refreshPlan(); };
  $$('input[name=cutMode]').forEach((r) => r.addEventListener('change', onSetting));
  $('#quality').addEventListener('change', onSetting);
  $('#resolution').addEventListener('change', () => { state.savedResolution = $('#resolution').value; onSetting(); });
  $('#outFormat').addEventListener('change', () => {
    if (audioMode() === 'only') state.audioFormat = $('#outFormat').value; else state.videoFormat = $('#outFormat').value;
    onSetting();
  });
  $('#audioMode').addEventListener('change', () => { applyFormatOptions(); onSetting(); });
  $('#btnSnap').addEventListener('click', saveSnapshot);
  restoreSettings();

  // Action
  $('#btnGo').addEventListener('click', runJob);
  $('#btnCancel').addEventListener('click', async () => {
    $('#btnCancel').disabled = true;
    try {
      if (state.segJob) state.segJob.signal.cancelled = true;
      else await state.conversion?.cancel();
    } finally { $('#btnCancel').disabled = false; }
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (!state.input || state.running) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if ((tag === 'input' && e.target.type !== 'range') || tag === 'select' || tag === 'textarea') return;
    if (tag === 'button' && (e.key === ' ' || e.key === 'Enter')) return; // let the focused button handle it
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': e.preventDefault(); if (e.shiftKey) jumpKeyframe(-1); else nudge(-frameStep()); break;
      case 'ArrowRight': e.preventDefault(); if (e.shiftKey) jumpKeyframe(1); else nudge(frameStep()); break;
      case 'Home': e.preventDefault(); seekTo(0); break;
      case 'End': e.preventDefault(); seekTo(state.duration); break;
      case 'i': case 'I': setPoint('in'); break;
      case 'o': case 'O': setPoint('out'); break;
      case '[': seekTo(state.tab === 'trim' ? state.trimAmount : state.tab === 'cutout' ? state.cutFrom : state.inPoint); break;
      case ']': seekTo(state.tab === 'cutout' ? state.cutTo : state.outPoint); break;
      default: return;
    }
  });

  // Warn before leaving mid-job.
  window.addEventListener('beforeunload', (e) => { if (state.running) { e.preventDefault(); e.returnValue = ''; } });
}

async function setPoint(which) {
  const t = await playheadPoint();
  if (state.tab === 'trim') { if (which === 'in') state.trimAmount = t; }
  else if (state.tab === 'cutout') { if (which === 'in') state.cutFrom = t; else state.cutTo = t; }
  else if (which === 'in') state.inPoint = t; else state.outPoint = t;
  syncTimeInputs(); updateTimeline(); refreshPlan();
}

function nudge(dt) {
  if (state.previewMode === 'video') $('#player').pause();
  seekTo(currentTime() + dt);
}

function selectTab(tab) {
  state.tab = tab;
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  updateTimeline();
  refreshPlan();
}

if (!MB) {
  showCapabilityNotes();
} else {
  wire();
}
