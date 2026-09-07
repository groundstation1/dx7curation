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

interface Bar {
  pitch: number;
  velocity: number;
  start: number;
  end: number | null;
}

let canvas: HTMLCanvasElement | null = null;
let bars: Bar[] = [];
let frame = 0;

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
  const keyW = w / (span + 1);
  const barW = Math.max(4, keyW * 0.8);

  // Additive, so overlapping notes brighten each other the way light does.
  ctx.globalCompositeOperation = 'lighter';

  let live = false;
  for (const bar of bars) {
    const top = h - (now - bar.start) * SPEED;
    const bottom = bar.end === null ? h : h - (now - bar.end) * SPEED;
    if (bottom < -4) continue;
    live = true;
    if (bar.end !== null && now - bar.end > FADE_SEC + (bottom - top) / SPEED) continue;

    const x = ((bar.pitch - LOW) / span) * (w - keyW) + keyW / 2;
    const vel = bar.velocity / 127;
    // Velocity is width as well as brightness. One line of one colour is a
    // graph; a thick bright note next to a thin dim one is a performance.
    const width = barW * (0.55 + 0.75 * vel);
    // Hue is velocity, not pitch: a cool blue for a whisper through to a hot
    // orange for a hammered note, the same cool-to-warm ramp the operator
    // colours use. Pitch is already the horizontal position, and colouring it
    // twice would leave velocity - the thing you cannot see anywhere else -
    // invisible.
    const hue = 265 - vel * 240;
    const alpha = bar.end === null ? 1 : Math.max(0, 1 - (now - bar.end) / (FADE_SEC + 0.6));
    const y = Math.max(0, top);
    const height = Math.max(2, Math.min(h, bottom) - y);

    // The bar wavers as it rises. A perfectly straight rectangle reads as a
    // chart; a slight waver reads as something alive, and it is the same
    // gesture as the vibrato these patches are full of. Amplitude is small
    // enough that pitch is still legible from horizontal position.
    const wobble = 1.6 + 1.4 * vel;
    const phase = bar.pitch * 1.7;
    const centreAt = (yy: number) => x + wobble * Math.sin(yy * 0.055 + phase + now * 1.6);

    const path = (offset: number) => {
      const p2 = new Path2D();
      for (let yy = y; yy <= y + height + 0.001; yy += 5) {
        const at = Math.min(yy, y + height);
        const cx = centreAt(at) + offset;
        if (yy === y) p2.moveTo(cx, at);
        else p2.lineTo(cx, at);
      }
      const endY = y + height;
      p2.lineTo(centreAt(endY) + offset, endY);
      return p2;
    };

    // Square ends, both of them: a bar is a slice of time cut off by the edges
    // of the strip, not an object with ends of its own. Butt caps, no radii.
    ctx.lineCap = 'butt';
    const centre = path(0);

    // Halo, body, then a thin bright line down each edge. The light lives on
    // the edges rather than the middle, which is what makes it read as a lit
    // tube instead of a coloured bar.
    ctx.strokeStyle = oklch(0.5, 0.17, hue, 0.12 * alpha * (0.4 + 0.6 * vel));
    ctx.lineWidth = width + 12;
    ctx.stroke(centre);
    ctx.strokeStyle = oklch(0.6, 0.17, hue, 0.16 * alpha);
    ctx.lineWidth = width + 5;
    ctx.stroke(centre);
    ctx.strokeStyle = oklch(0.66, 0.15, hue, 0.28 * alpha);
    ctx.lineWidth = width;
    ctx.stroke(centre);

    const edge = Math.max(1, width * 0.16);
    ctx.strokeStyle = oklch(0.9 + 0.06 * vel, 0.07, hue, (0.6 + 0.3 * vel) * alpha);
    ctx.lineWidth = edge;
    ctx.stroke(path(-(width - edge) / 2));
    ctx.stroke(path((width - edge) / 2));

    // A dimmer cap across the leading end, so the bar is closed rather than
    // simply stopping. Half the brightness of the sides: it is the end of the
    // tube, not another edge of it.
    if (top >= 0) {
      const cx = centreAt(y);
      ctx.strokeStyle = oklch(0.9, 0.07, hue, (0.3 + 0.15 * vel) * alpha);
      ctx.lineWidth = Math.max(1, edge * 0.8);
      ctx.beginPath();
      ctx.moveTo(cx - width / 2, y + 0.5);
      ctx.lineTo(cx + width / 2, y + 0.5);
      ctx.stroke();
    }

    // While the key is down, a bloom sits where the bar meets the edge and
    // breathes. It is the difference between a note that has been played and a
    // note that is being played - the same distinction a lit key makes on a
    // real keyboard, and the reason to look down here at all.
    if (bar.end === null) {
      // Shallow and quick: a shimmer, not a blinking light.
      const pulse = 0.85 + 0.15 * Math.sin(now * 11 + bar.pitch * 0.7);
      const rx = width * 2.6;
      const ry = 26;
      const fx = centreAt(h);
      const g = ctx.createRadialGradient(fx, h, 0, fx, h, Math.max(rx, ry));
      g.addColorStop(0, oklch(0.95, 0.06, hue, 0.5 * pulse * (0.5 + 0.5 * vel)));
      g.addColorStop(0.45, oklch(0.75, 0.15, hue, 0.22 * pulse));
      g.addColorStop(1, oklch(0.6, 0.15, hue, 0));
      ctx.save();
      ctx.translate(fx, h);
      ctx.scale(rx / Math.max(rx, ry), ry / Math.max(rx, ry));
      ctx.translate(-fx, -h);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(fx, h, Math.max(rx, ry), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // The two edges brighten at the very bottom, so the bloom has something
      // to come from without lighting up the middle of the bar.
      ctx.fillStyle = oklch(0.97, 0.04, hue, 0.5 + 0.4 * pulse);
      const foot = centreAt(h);
      ctx.fillRect(foot - width / 2, h - 3, edge, 3);
      ctx.fillRect(foot + width / 2 - edge, h - 3, edge, 3);
    }
  }
  ctx.globalCompositeOperation = 'source-over';

  bars = bars.filter((b) => b.end === null || (performance.now() / 1000 - b.end) < 6);
  const held = bars.some((b) => b.end === null);
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
    if (on) {
      bars.push({ pitch: note, velocity, start: performance.now() / 1000, end: null });
      if (bars.length > 96) bars.splice(0, bars.length - 96);
    } else {
      for (let i = bars.length - 1; i >= 0; i--) {
        if (bars[i].pitch === note && bars[i].end === null) {
          bars[i].end = performance.now() / 1000;
          break;
        }
      }
    }
    wake();
  });
}
