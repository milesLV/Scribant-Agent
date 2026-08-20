// Rolling audio window for diarized capture. Pure + browser-safe (no node imports).
//
// Cloud STT's sync `recognize` clusters speakers within ONE request. Handing it 8 seconds at a time
// gives it almost nothing to cluster on, so two voices in a short clip routinely come back as one —
// and because tags are numbered per request, the labels it does produce mean nothing across chunks.
//
// The fix is to stop sending chunks and start sending a WINDOW: the last WINDOW_MS of audio, every
// STEP_MS. The recognizer sees several times more audio per speaker, and consecutive windows share
// most of their content, which is what lets speaker-registry.ts anchor identity on the overlap.
// Only the newly-final tail is ever appended to the transcript (see EMIT_LAG_MS).

/** How much audio each request carries. Long enough for the clusterer to separate two voices. */
export const WINDOW_MS = 30_000;
/** How often a window is sent. Also the old per-chunk cadence, so latency is unchanged. */
export const STEP_MS = 8_000;
/**
 * Trailing audio held back from committing. A turn still running at the window edge is cut by the
 * edge, not by the speaker — committing its first half is exactly how a turn straddling a boundary
 * used to get re-clustered and misattributed. It arrives whole one step later.
 */
export const EMIT_LAG_MS = 1_500;
/** Cloud STT's native rate for conversational models. Sending 48 kHz just pays to downsample twice. */
export const TARGET_SAMPLE_RATE = 16_000;

/** Average the channels. Diarization is worse on a stereo pair read as two independent streams. */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * Resample by averaging each output sample's whole source span.
 *
 * Deliberately a box filter rather than nearest-neighbour or linear interpolation: dropping from
 * 48 kHz to 16 kHz without any lowpass folds everything above 8 kHz back into the speech band as
 * aliasing, which is audible to a recognizer even when it isn't to a person. Averaging the span is
 * a crude lowpass that costs three lines and handles non-integer ratios for free.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / (end - start);
  }
  return out;
}

/** Float samples to a 16-bit PCM WAV. Cloud STT reads LINEAR16 without sniffing a container. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);      // fmt chunk size
  view.setUint16(20, 1, true);       // PCM
  view.setUint16(22, 1, true);       // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);       // block align
  view.setUint16(34, 16, true);      // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}

/**
 * Base64 without a FileReader round trip. Chunked because `String.fromCharCode(...bytes)` blows the
 * call stack well below a window's ~960 KB.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Fixed-capacity ring of the most recent WINDOW_MS of mono 16 kHz audio.
 *
 * Holds samples, not encoded blobs: webm/opus fragments cannot be concatenated (only the first
 * carries a container header), which is the constraint that forced one standalone request per chunk
 * in the first place. Decoding to PCM on arrival dissolves it and gives sample-accurate timing.
 */
export class AudioWindow {
  private readonly buffer: Float32Array;
  private cursor = 0;
  /** Samples ever written, not samples held — this is what makes window timing absolute. */
  private written = 0;

  constructor(readonly sampleRate = TARGET_SAMPLE_RATE, windowMs = WINDOW_MS) {
    this.buffer = new Float32Array(Math.round((sampleRate * windowMs) / 1000));
  }

  /** Append already-mono, already-resampled samples, overwriting the oldest audio. */
  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.cursor] = samples[i];
      this.cursor = (this.cursor + 1) % this.buffer.length;
    }
    this.written += samples.length;
  }

  /** Absolute session time of the first sample the ring still holds. */
  get startMs(): number {
    return Math.max(0, this.written - this.buffer.length) / this.sampleRate * 1000;
  }

  /** Absolute session time of the most recent sample. */
  get endMs(): number {
    return (this.written / this.sampleRate) * 1000;
  }

  /** Oldest-first copy of everything held. */
  read(): Float32Array {
    const held = Math.min(this.written, this.buffer.length);
    const out = new Float32Array(held);
    const start = this.written < this.buffer.length ? 0 : this.cursor;
    for (let i = 0; i < held; i++) out[i] = this.buffer[(start + i) % this.buffer.length];
    return out;
  }

  /** The whole window as a base64 LINEAR16 WAV, plus the absolute time of its first sample. */
  snapshot(): { audio: string; windowStartMs: number; sampleRate: number } {
    return {
      audio: toBase64(encodeWav(this.read(), this.sampleRate)),
      windowStartMs: this.startMs,
      sampleRate: this.sampleRate,
    };
  }

  reset(): void {
    this.buffer.fill(0);
    this.cursor = 0;
    this.written = 0;
  }
}

// ponytail: self-check pins the ring's wrap arithmetic, the resampler's anti-alias averaging, and
// the WAV header. Run: tsx src/utils/audio-window.ts
if (typeof process !== "undefined" && process.argv[1]?.endsWith("audio-window.ts")) {
  const ok = (cond: unknown, m: string) => { if (!cond) throw new Error(m); };
  const eq = (a: unknown, b: unknown, m: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };

  // --- downmix ---
  eq([...downmixToMono([new Float32Array([1, -1]), new Float32Array([0, 1])])], [0.5, 0],
    "stereo averages to mono");
  const solo = new Float32Array([0.25]);
  ok(downmixToMono([solo]) === solo, "a single channel is passed through, not copied");

  // --- resample: 3:1 averages the span rather than picking one sample ---
  eq([...resample(new Float32Array([0, 3, 6, 9, 12, 15]), 48000, 16000)], [3, 12],
    "48k -> 16k averages each 3-sample span");
  eq(resample(new Float32Array([1, 2]), 16000, 16000).length, 2, "matching rates are a no-op");
  ok(resample(new Float32Array(48000), 48000, 16000).length === 16000, "one second stays one second");
  // A tone above the new Nyquist must be attenuated, not folded back into the speech band.
  const nyquistBuster = new Float32Array(4800);
  for (let i = 0; i < nyquistBuster.length; i++) nyquistBuster[i] = i % 2 ? 1 : -1; // 24 kHz
  const peak = Math.max(...resample(nyquistBuster, 48000, 16000).map(Math.abs));
  ok(peak < 0.5, `alias tone attenuated (peak ${peak})`);

  // --- WAV header ---
  const wav = encodeWav(new Float32Array([0, 1, -1]), 16000);
  eq(wav.length, 44 + 6, "header plus 2 bytes per sample");
  eq(String.fromCharCode(...wav.subarray(0, 4)), "RIFF", "RIFF magic");
  eq(String.fromCharCode(...wav.subarray(8, 12)), "WAVE", "WAVE magic");
  const dv = new DataView(wav.buffer);
  eq(dv.getUint32(24, true), 16000, "sample rate in header");
  eq(dv.getUint16(22, true), 1, "declared mono");
  eq(dv.getInt16(44 + 2, true), 32767, "+1.0 clamps to int16 max");
  eq(dv.getInt16(44 + 4, true), -32768, "-1.0 clamps to int16 min");

  // --- ring buffer ---
  const w = new AudioWindow(1000, 3000); // 3 s at 1 kHz = 3000 samples
  w.push(new Float32Array(1000).fill(1));
  eq(w.read().length, 1000, "partial window reads only what it holds");
  eq(w.startMs, 0, "nothing evicted yet");
  eq(w.endMs, 1000, "one second written");

  w.push(new Float32Array(2500).fill(2));
  eq(w.read().length, 3000, "ring is full and stays capped");
  eq(w.endMs, 3500, "absolute time keeps counting past the ring's capacity");
  eq(w.startMs, 500, "window start advances as audio is evicted");
  const held = w.read();
  eq(held[held.length - 1], 2, "newest sample is last");
  eq(held[0], 1, "oldest surviving sample is first, wrap handled");
  // The 500 evicted samples were all 1s, so 500 of them should remain.
  eq(held.filter(v => v === 1).length, 500, "exactly the un-evicted tail of the old audio survives");

  const snap = w.snapshot();
  eq(snap.windowStartMs, 500, "snapshot carries the absolute window start");
  const decoded = atob(snap.audio);
  eq(decoded.length, 44 + 3000 * 2, "base64 round-trips to the exact WAV byte count");
  eq(decoded.slice(0, 4), "RIFF", "...and it is still a WAV after encoding");
  eq(snap.sampleRate, 1000, "snapshot reports the rate the header declares");

  w.reset();
  eq(w.read().length, 0, "reset empties the ring");
  eq(w.endMs, 0, "reset restarts the clock");

  console.log("audio-window self-check ✓");
}
