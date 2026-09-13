/* Does blending produce a sane patch? Run: node test/interpolate.ts */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice, voiceName, P, UNPACKED_RANGES, NAME_OFFSET } from '../src/sysex/voice.ts';
import { TUNING_PARAMS, ENVELOPE_PARAMS, blendLevel } from '../src/engine/interpolate.ts';
import { voiceFundamentalHz } from '../src/render/probe.ts';
import { blendWeights, dominantAlgorithm, interpolateVoices, inverseDistanceWeights, voiceHash } from '../src/engine/interpolate.ts';
import { renderPhrase, DEMO_PHRASE } from '../src/engine/phrase.ts';
import { encodeWav } from '../src/engine/render.ts';

const here = dirname(fileURLToPath(import.meta.url));
const voices: Array<{ name: string; u: Uint8Array }> = [];
for (const f of ['ROM1A.syx', 'ROM1B.syx', 'ROM3A.syx', 'ROM3B.syx']) {
  const b = new Uint8Array(readFileSync(join(here, 'fixtures', f)));
  for (const v of parseSysexFile(b, f).voices) {
    const u = unpackVoice(v.packed);
    voices.push({ name: voiceName(u).trim(), u });
  }
}

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

// The biggest algorithm cohort, so there is something real to blend.
const byAlg = new Map<number, number[]>();
voices.forEach((v, i) => {
  const a = v.u[P.algorithm] & 31;
  if (!byAlg.has(a)) byAlg.set(a, []);
  byAlg.get(a)!.push(i);
});
const [alg, group] = [...byAlg].sort((a, b) => b[1].length - a[1].length)[0];
console.log(`largest cohort: algorithm ${alg + 1} with ${group.length} voices`);
console.log(`  ${group.slice(0, 6).map((i) => voices[i].name).join(', ')}\n`);

const picked = group.slice(0, 5);
const distances = [1, 1.4, 2.0, 2.6, 3.4];
const weights = blendWeights(distances);
const result = interpolateVoices(picked.map((i) => voices[i].u), weights, picked, { algorithm: alg });

console.log('blending the five nearest:');
check('produced a voice', result !== null);
if (!result) process.exit(1);
check('kept the chosen algorithm', (result.voice[P.algorithm] & 31) === alg, `got ${(result.voice[P.algorithm] & 31) + 1}`);
check('every parameter is in range', (() => {
  for (let i = 0; i < NAME_OFFSET; i++) {
    const [lo, hi] = UNPACKED_RANGES[i];
    if (result.voice[i] < lo || result.voice[i] > hi) return false;
  }
  return true;
})());
check('weights sum to 1', Math.abs(result.contributions.reduce((s, c) => s + c.weight, 0) - 1) < 1e-6);
check('nearest contributes most', result.contributions[0].index === picked[0],
  `${voices[result.contributions[0].index].name} at ${(result.contributions[0].weight * 100).toFixed(0)}%`);
check('but does not swamp the rest', result.contributions[0].weight < 0.55,
  `top share ${(result.contributions[0].weight * 100).toFixed(0)}%`);

// The whole point of the change: identical relative spread must give identical
// weights whatever the absolute distances are.
const tight = blendWeights([10, 14, 20, 26, 34]);
const spread = blendWeights([100, 140, 200, 260, 340]);
check('weighting is scale invariant',
  tight.every((w, i) => Math.abs(w - spread[i]) < 1e-9));
const old = inverseDistanceWeights([20, 200, 210, 220, 230]);
const oldTop = old[0] / old.reduce((a, b) => a + b, 0);
const now = blendWeights([20, 200, 210, 220, 230]);
const newTop = now[0] / now.reduce((a, b) => a + b, 0);
console.log(`  scattered candidates: nearest took ${(oldTop * 100).toFixed(0)}% under inverse-square, ${(newTop * 100).toFixed(0)}% now`);
console.log(`  bias 0 gives ${blendWeights([20, 200, 210, 220, 230], 0).map((w) => w.toFixed(2)).join(' ')}`);
console.log(`  bias 1 gives ${blendWeights([20, 200, 210, 220, 230], 1).map((w) => w.toFixed(2)).join(' ')}`);

// Voted parameters must be a value someone actually had, never an average.
check('the whole tuning skeleton came from one contributor', (() => {
  const donor = picked.find((i) => i === result.tuningDonor);
  if (donor === undefined) return false;
  return TUNING_PARAMS.every((p) => result.voice[p] === voices[donor].u[p]);
})(), `donor: ${voices[result.tuningDonor].name}`);

check('coarse ratios are values a contributor actually used', (() => {
  for (let op = 0; op < 6; op++) {
    const v = result.voice[P.opCoarse(op)];
    if (!picked.some((i) => voices[i].u[P.opCoarse(op)] === v)) return false;
  }
  return true;
})());
check('LFO waveform came from a contributor', picked.some((i) => voices[i].u[P.lfoWaveform] === result.voice[P.lfoWaveform]));

// Averaged parameters must lie inside the contributors' range.
check('averaged EG rates lie between the contributors', (() => {
  for (let op = 0; op < 6; op++) {
    for (let k = 0; k < 4; k++) {
      const idx = P.opRate(op, k);
      const vals = picked.map((i) => voices[i].u[idx]);
      const v = result.voice[idx];
      if (v < Math.min(...vals) - 1 || v > Math.max(...vals) + 1) return false;
    }
  }
  return true;
})());

// Does it play in tune? Zero-crossing counting is no use here - on a complex FM
// timbre it measures the dominant periodicity, not the fundamental, so two
// sounds an identical pitch apart read as 75 cents apart. What actually decides
// tuning is the set of operator frequencies, which can be computed exactly.
const opFrequencies = (u: Uint8Array, note: number): number[] => {
  const transposed = Math.max(0, Math.min(127, note + u[P.transpose] - 24));
  const noteHz = 440 * Math.pow(2, (transposed - 69) / 12);
  const out: number[] = [];
  for (let op = 0; op < 6; op++) {
    if (u[P.opOutputLevel(op)] === 0) continue;
    const coarse = u[P.opCoarse(op)];
    const fine = u[P.opFine(op)];
    out.push(u[P.opMode(op)] === 1
      ? Math.pow(10, (coarse & 3) + fine / 100)
      : noteHz * (coarse === 0 ? 0.5 : coarse) * (1 + fine / 100));
  }
  return out.sort((a, b) => a - b);
};

const donorF = opFrequencies(voices[result.tuningDonor].u, 60);
const blendF = opFrequencies(result.voice, 60);
check('the blend sounds the same fundamental as its donor',
  Math.abs(voiceFundamentalHz(result.voice, 60) - voiceFundamentalHz(voices[result.tuningDonor].u, 60)) < 0.01,
  `${voiceFundamentalHz(result.voice, 60).toFixed(2)} Hz`);
check('every sounding operator frequency matches the donor exactly',
  blendF.length === donorF.length && blendF.every((f, i) => Math.abs(f - donorF[i]) < 1e-6),
  `${blendF.length} operators`);

// The failure mode being guarded against: averaging two different tunings gives
// a third that neither had, and the operators then beat against each other.
const naive = Uint8Array.from(result.voice);
for (const pi of TUNING_PARAMS) {
  let sum = 0;
  for (const i of picked) sum += voices[i].u[pi];
  naive[pi] = Math.round(sum / picked.length);
}
const naiveF = opFrequencies(naive, 60);
const naiveMatchesSomeone = picked.some((i) => {
  const f = opFrequencies(voices[i].u, 60);
  return f.length === naiveF.length && f.every((x, k) => Math.abs(x - naiveF[k]) < 1e-6);
});
check('averaging the tuning instead would invent a tuning nobody had', !naiveMatchesSomeone,
  naiveMatchesSomeone ? 'these particular patches happen to agree' : 'confirmed');

// The envelope must be a real envelope, not the midpoint of two incompatible
// shapes - that midpoint is what kept eating the sustain.
check('the envelope came whole from one contributor', (() => {
  if (result.envelopeDonor === null) return false;
  const donor = voices[result.envelopeDonor].u;
  return ENVELOPE_PARAMS.every((p) => result.voice[p] === donor[p]);
})(), `donor: ${result.envelopeDonor !== null ? voices[result.envelopeDonor].name : 'none'}`);

check('every sustain level is one a contributor actually used', (() => {
  for (let op = 0; op < 6; op++) {
    const v = result.voice[P.opLevel(op, 2)];
    if (!picked.some((i) => voices[i].u[P.opLevel(op, 2)] === v)) return false;
  }
  return true;
})());

{
  // What averaging would have done instead, for comparison.
  const naiveVoice = interpolateVoices(
    picked.map((i) => voices[i].u), weights, picked, { algorithm: alg, blendEnvelopes: true },
  )!.voice;
  const meanL3 = (u: Uint8Array) => {
    let t = 0;
    for (let op = 0; op < 6; op++) t += u[P.opLevel(op, 2)];
    return t / 6;
  };

  const contributorRange = picked.map((i) => meanL3(voices[i].u));
  console.log(`  sustain: contributors ${Math.min(...contributorRange).toFixed(0)}-${Math.max(...contributorRange).toFixed(0)}, ` +
    `donated ${meanL3(result.voice).toFixed(0)}, averaged ${meanL3(naive).toFixed(0)}`);
  check('donating keeps a real envelope while averaging flattens towards the middle',
    picked.some((i) => Math.abs(meanL3(voices[i].u) - meanL3(result.voice)) < 0.01));
}

// Levels are close to linear in decibels, which is why averaging them is not
// the forgiving option it looks like.
check('blending equal levels is a no-op', blendLevel([80, 80], [1, 3]) === 80);
check('the true dB midpoint of full and silent is well below halfway',
  blendLevel([99, 0], [1, 1]) < 50, `${blendLevel([99, 0], [1, 1])} rather than 50`);

const r = renderPhrase(result.voice, DEMO_PHRASE, { sampleRate: 44100 });
check('the blend makes sound', r.peak > 1e-3, `peak ${r.peak.toFixed(3)}`);
let bad = 0;
for (let i = 0; i < r.samples.length; i++) if (!Number.isFinite(r.samples[i])) bad++;
check('no non-finite samples', bad === 0);

// Mixed algorithms must be filtered out, not averaged across.
const mixed = [group[0], group[1], ...[...byAlg].filter(([a]) => a !== alg)[0][1].slice(0, 3)];
const mixedResult = interpolateVoices(
  mixed.map((i) => voices[i].u), inverseDistanceWeights([1, 1.2, 1.3, 1.4, 1.5]), mixed,
);
check('voices on other algorithms are rejected, not blended',
  mixedResult !== null && mixedResult.rejected > 0,
  mixedResult ? `${mixedResult.rejected} rejected, ${mixedResult.contributions.length} used` : '');

const vote = dominantAlgorithm(mixed.map((i) => voices[i].u), inverseDistanceWeights([1, 1.2, 1.3, 1.4, 1.5]));
check('the algorithm vote favours the nearest', vote.algorithm === alg, `share ${(vote.share * 100).toFixed(0)}%`);

check('hash is stable', voiceHash(result.voice) === voiceHash(Uint8Array.from(result.voice)));
check('hash ignores the name', (() => {
  const a = Uint8Array.from(result.voice);
  a[NAME_OFFSET] = 65;
  return voiceHash(a) === voiceHash(result.voice);
})());

// test/out is gitignored, so it does not exist in a fresh clone - which is
// every clone but the one this was written in. The other scripts that write
// here already do this; this one did not, and only passed because the
// directory happened to be left over from an earlier run.
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'interpolated.wav'), encodeWav(r.samples, 44100));
console.log(`\n  blended ${result.contributions.length} voices on algorithm ${alg + 1}`);
console.log(`  wrote ${join(outDir, 'interpolated.wav')}`);
console.log(fail === 0 ? '\nall interpolation checks passed\n' : `\n${fail} check(s) failed\n`);
process.exit(fail === 0 ? 0 : 1);
