/* DX7 pitch envelope - port of msfa pitchenv.cc (Google Inc.), Apache 2.0. */
import { pitchenvRate, pitchenvTab, rateState } from './tables.ts';

export class PitchEnv {
  private rates = [0, 0, 0, 0];
  private levels = [0, 0, 0, 0];
  private level = 0;
  private targetlevel = 0;
  private rising = false;
  private ix = 0;
  private inc = 0;
  private down = true;

  set(rates: ArrayLike<number>, levels: ArrayLike<number>): void {
    for (let i = 0; i < 4; i++) {
      this.rates[i] = rates[i];
      this.levels[i] = levels[i];
    }
    this.level = pitchenvTab[levels[3]] << 19;
    this.down = true;
    this.advance(0);
  }

  /** Result is Q24 per octave. */
  getsample(): number {
    if (this.ix < 3 || (this.ix < 4 && !this.down)) {
      if (this.rising) {
        this.level += this.inc;
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
      this.targetlevel = pitchenvTab[this.levels[this.ix]] << 19;
      this.rising = this.targetlevel > this.level;
      this.inc = pitchenvRate[this.rates[this.ix]] * rateState.pitchEnvUnit;
    }
  }
}
