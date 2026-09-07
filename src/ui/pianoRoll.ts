/*
 * What you just played, along the bottom edge of the window.
 *
 * A strip of piano roll scrolling upwards out of the bottom of the screen and
 * fading as it goes. It is not a feature so much as a confirmation: when you
 * press a key and the patch under the cursor is silent - because it is a
 * modulator-heavy sound, because the note is out of its range, because the
 * wrong thing is armed - the only way to tell "nothing was sent" from
 * "something was sent and made no sound" was to look at the transport's note
 * counter. Now the note is simply there, in the corner of your eye.
 *
 * Nothing but MIDI input draws here. Auditions and the demo phrase do not: the
 * strip means "your hardware sent this".
 *
 * The trail is recorded, not recomputed. Each held note emits one sample per
 * frame at the bottom edge, and those samples afterwards only ever scroll: what
 * a note did a second ago cannot change because you moved the mod wheel now,
 * any more than it could on tape. That is what makes this a piano roll rather
 * than an animated shape - it is a record of what happened, and a record that
 * rewrites its own past is not one.
 */
import { keyboard } from '../audio/keyboard.ts';
import { oklch } from './colour.ts';

/** Piano range, A0 to C8, which is what the strip maps across its width. */
const LOW = 21;
const HIGH = 108;
const HEIGHT = 92;
/** Pixels a second of history takes. Two seconds fit in the strip. */
const SPEED = 46;
/** How long a released note takes to fade out once it has stopped growing. */
const FADE_SEC = 1.6;
/**
 * Radians a second for the two wavers, and how far each swings.
 *
 * The slow one is the patch's own detune: operators pulled either side of
 * centre beat against each other a few times a second. The fast one is the mod
 * wheel, which on a DX7 is vibrato - properly quick, and worth the wider swing
 * because it is something you are doing rather than something the patch is.
 */
const SLOW_RATE = 9;
const FAST_RATE = 72;
const SLOW_AMP = 2.1;
const FAST_AMP = 2.4;
/** No more than this many samples a second, however fast the display refreshes. */
const MAX_SAMPLE_HZ = 120;

interface Bar {
  pitch: number;
  velocity: number;
  start: number;
  end: number | null;
  /** Detune of the patch it was played with, 0 to 1. */
  detune: number;
  /** Oscillator state, advanced only while the note is held. */
  slowPhase: number;
  fastPhase: number;
  lastSample: number;
  /** The trail: an offset, and the moment it was emitted. Oldest first. */
  dx: number[];
  at: number[];
}

let canvas: HTMLCanvasElement | null = null;
let bars: Bar[] = [];
let frame = 0;

/**
 * Extend a held note's trail with one sample at the bottom edge.
 *
 * The amplitudes are read now and apply to this sample alone: turning the mod
 * wheel up makes the note wiggle from here on and leaves what it already drew
 * exactly as it was. `keyboard.modWheel` is the value after the dead zone, so a
 * wheel that does not quite rest at zero still draws a straight line.
 */
function sample(bar: Bar, now: number, mod: number): void {
  const dt = now - bar.lastSample;
  if (dt < 1 / MAX_SAMPLE_HZ) return;
  bar.lastSample = now;
  bar.slowPhase += dt * SLOW_RATE;
  bar.fastPhase += dt * FAST_RATE;
  bar.dx.push(SLOW_AMP * bar.detune * Math.sin(bar.slowPhase) + FAST_AMP * mod * Math.sin(bar.fastPhase));
  bar.at.push(now);
  // Anything that has scrolled off the top is gone for good.
  const cutoff = now - (HEIGHT + 8) / SPEED;
  let drop = 0;
  while (drop < bar.at.length - 2 && bar.at[drop] < cutoff) drop++;
  if (drop > 0) {
    bar.dx.splice(0, drop);
    bar.at.splice(0, drop);
  }
}

/**
 * Velocity to hue, cool for a whisper through to hot for a hammered note.
 *
 * Steepened around the middle, because that is where playing actually lives: a
 * straight ramp spends most of its colour on velocities nobody sends, and 70
 * against 95 - the difference between a soft chord and a firm one - came out
 * as two shades of the same green.
 */
function velocityHue(vel: number): number {
  const t = 0.5 + 0.5 * Math.tanh((vel - 0.52) * 3.4);
  return 268 - t * 258;
}

function draw(): void {
  frame = 0;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = HEIGHT;
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const now = performance.now() / 1000;
  const span = HIGH - LOW;
  // Keys are drawn edge to edge: a run of notes should read as one ribbon of
  // light rather than a row of separate sticks.
  const keyW = w / (span + 1);
  const mod = keyboard.modWheel;

  // Additive, so overlapping notes brighten each other the way light does.
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';

  let live = false;
  let held = false;
  for (const bar of bars) {
    if (bar.end === null) {
      held = true;
      sample(bar, now, mod);
    }

    const x = ((bar.pitch - LOW) / span) * (w - keyW) + keyW / 2;
    const vel = bar.velocity / 127;
    const width = keyW;
    // Pitch is already the horizontal position, so colour carries velocity -
    // the thing there is nowhere else to see.
    const hue = velocityHue(vel);
    const alpha = bar.end === null ? 1 : Math.max(0, 1 - (now - bar.end) / (FADE_SEC + 0.6));
    if (alpha <= 0) continue;

    // The trail in screen space, dropping whatever has scrolled off the top.
    const px: number[] = [];
    const py: number[] = [];
    for (let i = 0; i < bar.at.length; i++) {
      const yy = h - (now - bar.at[i]) * SPEED;
      if (yy < -2) continue;
      px.push(x + bar.dx[i]);
      py.push(Math.min(h, yy));
    }
    if (px.length === 0) continue;
    // A note still held keeps its bottom end pinned to the edge.
    if (bar.end === null && py[py.length - 1] < h) {
      px.push(px[px.length - 1]);
      py.push(h);
    }
    if (px.length < 2) {
      px.push(px[0]);
      py.push(Math.min(h, py[0] + 1.5));
    }
    live = true;

    const path = (offset: number) => {
      const p = new Path2D();
      p.moveTo(px[0] + offset, py[0]);
      for (let i = 1; i < px.length; i++) p.lineTo(px[i] + offset, py[i]);
      return p;
    };
    const centre = path(0);

    // The halo, then the body.
    ctx.strokeStyle = oklch(0.5, 0.17, hue, 0.12 * alpha * (0.4 + 0.6 * vel));
    ctx.lineWidth = width + 12;
    ctx.stroke(centre);
    ctx.strokeStyle = oklch(0.6, 0.17, hue, 0.15 * alpha);
    ctx.lineWidth = width + 5;
    ctx.stroke(centre);

    // The light lives on the edges and falls away inwards. Drawn as copies of
    // the same path at fixed horizontal offsets rather than as a gradient
    // across the bar: a gradient is fixed in canvas space, so a waving bar
    // slides through it and its two edges appear to move independently. Offset
    // copies displace with the bar, which is what a bar actually does - the
    // whole thing moves, both sides together.
    const edge = Math.max(1, width * 0.16);
    const half = (width - edge) / 2;
    for (const [at, level] of [[1, 1], [0.62, 0.34], [0.3, 0.2]] as const) {
      ctx.strokeStyle = oklch(0.88 + 0.06 * vel, 0.08, hue, (0.6 + 0.28 * vel) * level * alpha);
      ctx.lineWidth = edge * (at === 1 ? 1 : 1.35);
      ctx.stroke(path(-half * at));
      if (at > 0) ctx.stroke(path(half * at));
    }


    // A dimmer cap across the leading end, so the bar is closed rather than
    // simply stopping. Fainter than the sides: it is the end of the tube, not
    // another edge of it.
    if (py[0] > 0.5) {
      ctx.strokeStyle = oklch(0.9, 0.07, hue, (0.28 + 0.14 * vel) * alpha);
      ctx.lineWidth = Math.max(1, edge * 0.8);
      ctx.beginPath();
      ctx.moveTo(px[0] - width / 2, py[0]);
      ctx.lineTo(px[0] + width / 2, py[0]);
      ctx.stroke();
    }

    // While the key is down, a bloom sits where the bar meets the edge and
    // shimmers. It is the difference between a note that has been played and a
    // note that is being played - the same distinction a lit key makes on a
    // real keyboard, and the reason to look down here at all.
    if (bar.end === null) {
      // Shallow and quick: a shimmer, not a blinking light.
      const pulse = 0.85 + 0.15 * Math.sin(now * 11 + bar.pitch * 0.7);
      const fx = px[px.length - 1];
      const rx = width * 2.6;
      const ry = 26;
      const radius = Math.max(rx, ry);
      const bloom = ctx.createRadialGradient(fx, h, 0, fx, h, radius);
      bloom.addColorStop(0, oklch(0.95, 0.06, hue, 0.5 * pulse * (0.5 + 0.5 * vel)));
      bloom.addColorStop(0.45, oklch(0.75, 0.15, hue, 0.22 * pulse));
      bloom.addColorStop(1, oklch(0.6, 0.15, hue, 0));
      ctx.save();
      ctx.translate(fx, h);
      ctx.scale(rx / radius, ry / radius);
      ctx.translate(-fx, -h);
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(fx, h, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // The two edges brighten at the very bottom, so the bloom has something
      // to come from without lighting up the middle of the bar.
      ctx.fillStyle = oklch(0.97, 0.04, hue, 0.5 + 0.4 * pulse);
      ctx.fillRect(fx - width / 2, h - 3, edge, 3);
      ctx.fillRect(fx + width / 2 - edge, h - 3, edge, 3);
    }
  }
  ctx.globalCompositeOperation = 'source-over';

  bars = bars.filter((b) => b.end === null || now - b.end < FADE_SEC + HEIGHT / SPEED + 1);
  if (live || held) frame = requestAnimationFrame(draw);
  else canvas.style.opacity = '0';
}

function wake(): void {
  if (!canvas) return;
  canvas.style.opacity = '1';
  if (!frame) frame = requestAnimationFrame(draw);
}

/**
 * Attach the strip to the page. Safe to call once, at startup: the canvas costs
 * nothing until a note arrives, and nothing at all is drawn while it is empty.
 */
export function mountPianoRoll(): void {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.className = 'piano-roll';
  canvas.style.opacity = '0';
  document.body.appendChild(canvas);

  keyboard.onNote((note, velocity, on) => {
    const now = performance.now() / 1000;
    if (on) {
      bars.push({
        pitch: note,
        velocity,
        start: now,
        end: null,
        detune: keyboard.engine.patchDetune,
        // A phase per note, so a chord does not waver in lockstep.
        slowPhase: note * 1.7,
        fastPhase: note * 0.9,
        lastSample: now - 1 / MAX_SAMPLE_HZ,
        dx: [],
        at: [],
      });
      if (bars.length > 96) bars.splice(0, bars.length - 96);
    } else {
      for (let i = bars.length - 1; i >= 0; i--) {
        if (bars[i].pitch === note && bars[i].end === null) {
          bars[i].end = now;
          break;
        }
      }
    }
    wake();
  });
}
