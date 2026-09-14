// Tiny synthesized sound kit (Web Audio API - no asset files, nothing to license or ship). Always
// on - the phone's mute switch is the mute button - and fails silent if audio is blocked. Sounds
// only fire from real user gestures, so the AudioContext is allowed to start.

let ctx: AudioContext | null = null;
function ac(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  } catch { return null; }
}

function soundOn(): boolean {
  return typeof window !== "undefined";
}

// One enveloped tone, optionally gliding to a second frequency.
function tone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; delay?: number; slideTo?: number } = {}) {
  const a = ac(); if (!a) return;
  const t0 = a.currentTime + (opts.delay || 0);
  const o = a.createOscillator(); const g = a.createGain();
  o.type = opts.type || "sine";
  o.frequency.setValueAtTime(freq, t0);
  if (opts.slideTo) o.frequency.exponentialRampToValueAtTime(opts.slideTo, t0 + dur);
  const peak = opts.gain ?? 0.06;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(a.destination);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

// A short filtered white-noise burst that sweeps down - the "whoosh".
function whoosh(dur = 0.5, gain = 0.09) {
  const a = ac(); if (!a) return;
  const frames = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, frames, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = a.createBufferSource(); src.buffer = buf;
  const lp = a.createBiquadFilter(); lp.type = "lowpass";
  lp.frequency.setValueAtTime(1800, a.currentTime);
  lp.frequency.exponentialRampToValueAtTime(300, a.currentTime + dur);
  const g = a.createGain(); g.gain.setValueAtTime(gain, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  src.connect(lp); lp.connect(g); g.connect(a.destination);
  src.start(); src.stop(a.currentTime + dur + 0.02);
}

// ── The kit ────────────────────────────────────────────────────────────────
/** Cash register - two bright rising dings. */
export function chaChing() {
  if (!soundOn()) return;
  tone(880, 0.12, { type: "triangle", gain: 0.08 });
  tone(1320, 0.22, { type: "triangle", gain: 0.08, delay: 0.1 });
  tone(1760, 0.28, { type: "sine", gain: 0.05, delay: 0.16 });
}
/** A win that isn't cash - a quick three-note arpeggio up. */
export function chime() {
  if (!soundOn()) return;
  [660, 880, 1100].forEach((f, i) => tone(f, 0.18, { type: "sine", gain: 0.05, delay: i * 0.07 }));
}
/** Streak flame - a warm whoosh + low swell. */
export function fire() {
  if (!soundOn()) return;
  whoosh(0.55, 0.08);
  tone(180, 0.4, { type: "sawtooth", gain: 0.04, slideTo: 320 });
}
/** Card snap - a soft pop. */
export function pop() {
  if (!soundOn()) return;
  tone(420, 0.09, { type: "sine", gain: 0.06, slideTo: 200 });
}
/** Tiny tick - one option dealt in. */
export function tick() {
  if (!soundOn()) return;
  tone(1180, 0.05, { type: "sine", gain: 0.04 });
}
/** Countdown beep; pass go=true for the final higher "go". */
export function beep(go = false) {
  if (!soundOn()) return;
  tone(go ? 1320 : 760, go ? 0.22 : 0.12, { type: "square", gain: 0.05 });
}
/** Mic on - a quick rising blip. */
export function micStart() {
  if (!soundOn()) return;
  tone(520, 0.14, { type: "sine", gain: 0.05, slideTo: 920 });
}
/** Mic off - the reverse, a falling blip. */
export function micStop() {
  if (!soundOn()) return;
  tone(760, 0.16, { type: "sine", gain: 0.05, slideTo: 320 });
}
