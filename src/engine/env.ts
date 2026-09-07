/*
 * DX7 operator envelope - port of msfa env.cc (Google Inc. / Pascal Gauthier),
 * Apache 2.0. ACCURATE_ENVELOPE is on, matching Dexed's default build.
 */
import { N, rateState } from './tables.ts';

const levellut = [0, 5, 9, 13, 17, 20, 23, 25, 27, 29, 31, 33, 35, 37, 39, 41, 42, 43, 45, 46];

// Approximate sample counts at 44.1 kHz for envelope segments that hold flat,
// measured empirically on hardware by the Dexed authors.
const statics = [
  1764000, 1764000, 1411200, 1411200, 1190700, 1014300, 992250,
  882000, 705600, 705600, 584325, 507150, 502740, 441000, 418950,
  352800, 308700, 286650, 253575, 220500, 220500, 176400, 145530,
  145530, 125685, 110250, 110250, 88200, 88200, 74970, 61740,
  61740, 55125, 48510, 44100, 37485, 31311, 30870, 27562, 27562,
  22050, 18522, 17640, 15435, 14112, 13230, 11025, 9261, 9261, 7717,
  6615, 6615, 5512, 5512, 4410, 3969, 3969, 3439, 2866, 2690, 2249,
  1984, 1896, 1808, 1411, 1367, 1234, 1146, 926, 837, 837, 705,
  573, 573, 529, 441, 441,
];

export function scaleOutLevel(outlevel: number): number {
  return outlevel >= 20 ? 28 + outlevel : levellut[outlevel];
}

export class Env {
  private rates = [0, 0, 0, 0];
  private levels = [0, 0, 0, 0];
  private outlevel = 0;
  private rateScaling = 0;
  /** Q24 log level: 2^24 is one doubling. */
  private level = 0;
  private targetlevel = 0;
  private rising = false;
  private ix = 0;
  private inc = 0;
  private staticcount = 0;
  private down = true;
  private initialised = false;

  init(rates: ArrayLike<number>, levels: ArrayLike<number>, outlevel: number, rateScaling: number): void {
    this.initialised = true;
    for (let i = 0; i < 4; i++) {
      this.rates[i] = rates[i];
      this.levels[i] = levels[i];
    }
    this.outlevel = outlevel;
    this.rateScaling = rateScaling;
    this.level = 0;
    this.down = true;
    this.advance(0);
  }

  getsample(): number {
    if (this.staticcount) {
      this.staticcount -= N;
      if (this.staticcount <= 0) {
        this.staticcount = 0;
        this.advance(this.ix + 1);
      }
    }

    if (this.ix < 3 || (this.ix < 4 && !this.down)) {
      if (this.staticcount) {
        // holding flat
      } else if (this.rising) {
        const jumptarget = 1716;
        if (this.level < jumptarget << 16) this.level = jumptarget << 16;
        this.level += ((285212672 - this.level) >> 24) * this.inc; // 17 << 24
        if (this.level >= this.targetlevel) {
          this.level = this.targetlevel;
          this.advance(this.ix + 1);
        }
      } else {
        this.level -= this.inc;
        if (this.level <= this.targetlevel) {
          this.level = this.targetlevel;
          this.advance(this.ix + 1);
        }
      }
    }
    return this.level;
  }

  keydown(d: boolean): void {
    if (this.down !== d) {
      this.down = d;
      this.advance(d ? 0 : 3);
    }
  }

  private advance(newix: number): void {
    this.ix = newix;
    if (this.ix < 4) {
      const newlevel = this.levels[this.ix];
      let actuallevel = scaleOutLevel(newlevel) >> 1;
      actuallevel = (actuallevel << 6) + this.outlevel - 4256;
      actuallevel = actuallevel < 16 ? 16 : actuallevel;
      this.targetlevel = actuallevel << 16;
      this.rising = this.targetlevel > this.level;

      let qrate = (this.rates[this.ix] * 41) >> 6;
      qrate += this.rateScaling;
      qrate = Math.min(qrate, 63);

      if (this.targetlevel === this.level || (this.ix === 0 && newlevel === 0)) {
        let staticrate = this.rates[this.ix] + this.rateScaling;
        staticrate = Math.min(staticrate, 99);
        let sc = staticrate < 77 ? statics[staticrate] : 20 * (99 - staticrate);
        if (staticrate < 77 && this.ix === 0 && newlevel === 0) sc = Math.trunc(sc / 20);
        this.staticcount = Math.floor((sc * rateState.envSrMultiplier) / 16777216);
      } else {
        this.staticcount = 0;
      }

      this.inc = (4 + (qrate & 3)) * Math.pow(2, 2 + 6 + (qrate >> 2));
      this.inc = Math.floor((this.inc * rateState.envSrMultiplier) / 16777216);
    }
  }

  isActive(): boolean {
    return this.initialised && (this.ix < 4 || this.levels[3] > 0);
  }

  get stage(): number {
    return this.ix;
  }
}
