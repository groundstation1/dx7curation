/*
 * Reading patch names. Run: node test/names.ts
 *
 * Two things are being checked. That the reader survives what a ten-character
 * name format does to English - truncation, glue, slot numbers, INIT VOICE -
 * and that the space built from it puts patches next to the ones they are
 * named like. The second is the whole point: if PIANO 1 is not near PIANO 2 in
 * the name space then the name space is worth nothing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { buildNameVocabulary, nameColumns, nameConceptIds, nameWords } from '../src/features/nameTokens.ts';
import { buildNameSpace, nameCloseness, nameSimilarity, NAME_MIN_AGREEMENT, NAME_PULL } from '../src/cluster/nameSpace.ts';
import { clusterAtThreshold, type NearDupeClusters } from '../src/cluster/nearDupe.ts';
import { fitTaste } from '../src/cluster/taste.ts';

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};
const has = (list: string[], word: string) => list.some((c) => c.includes(word));

console.log('reading names:');

check('a slot number is not vocabulary', String(nameWords('PIANO   5')) === 'piano');
// Two-letter words are dropped: on the real corpus they are overwhelmingly
// author initials and bookkeeping. The ones that do mean something are in the
// keyword tables already, so they still reach a concept.
check('a two-letter word is not vocabulary', String(nameWords('B3 ORGAN')) === 'organ');
check('but B3 still says Hammond', has(nameConceptIds('B3 ORGAN'), 'organ'));
check('a bare number is not a word', String(nameWords('60-S ORGAN')) === 'organ');
check('punctuation splits, and a stray letter is dropped',
  String(nameWords('E.PIANO 1')) === 'piano');
check('INIT VOICE says nothing at all',
  nameWords('INIT VOICE').length === 0 && nameConceptIds('INIT VOICE').length === 0);
check('but VOICE 1 is still a choir', has(nameConceptIds('VOICE   1'), 'choir'));
check('a truncation still finds its concept', has(nameConceptIds('HARPSICH 1'), 'keys'));
check('and so does a glued word', has(nameConceptIds('SPANISHGTR'), 'plucked'));
check('CALIOPE is a calliope', has(nameConceptIds('CALIOPE'), 'organ'));
check('an empty name is empty', nameWords('   ').length === 0);

// Truncation families have to become one word or they fall under the floor
// separately and all of them disappear.
const truncated = [
  ...Array.from({ length: 8 }, () => ['SOFT PIANO']),
  ...Array.from({ length: 6 }, () => ['BRITE PIAN']),
  ...Array.from({ length: 5 }, () => ['WARM PIA 2']),
  ...Array.from({ length: 9 }, () => ['DARK BASS']),
  ...Array.from({ length: 4 }, () => ['THIN BAS 1']),
];
const vocab = buildNameVocabulary(truncated);
const columns = (doc: string) => nameColumns([doc], vocab);
const shared = (a: string, b: string) => columns(a).some((c) => columns(b).includes(c));
check('a truncated instrument still reaches its concept',
  has(nameConceptIds('BRITE PIAN'), 'keys') && has(nameConceptIds('WARM PIA 2'), 'keys'),
  JSON.stringify(nameConceptIds('WARM PIA 2')));
check('so cut spellings land in the same column as the whole word',
  shared('SOFT PIANO', 'BRITE PIAN') && shared('SOFT PIANO', 'WARM PIA 2')
  && shared('DARK BASS', 'THIN BAS 1'),
  `${columns('SOFT PIANO')} / ${columns('BRITE PIAN')} / ${columns('WARM PIA 2')}`);
check('and a piano is not filed with the basses', !shared('SOFT PIANO', 'DARK BASS'));

// The same folding, one level down: words the concept table has never heard
// of still have to survive being cut in half.
const invented = buildNameVocabulary([
  ...Array.from({ length: 9 }, () => ['ZORBLATT 1']),
  ...Array.from({ length: 5 }, () => ['ZORBLA 2']),
  // Enough of a corpus around them that neither is a majority of it, or the
  // frequency ceiling throws both away before they can be folded together.
  ...Array.from({ length: 60 }, (_, i) => [`PIANO ${i % 8}`]),
]);
check('an unknown word absorbs its own truncations',
  invented.tokens.length === 1 && invented.labels.includes('zorblatt'),
  `${invented.tokens.join(' ')} | ${invented.labels.join(' ')}`);

// A word nobody uses is not worth a column, and one everybody uses separates
// nothing. Both ends have to hold or the vocabulary fills with noise.
const lopsided = buildNameVocabulary([
  ...Array.from({ length: 200 }, () => ['ZZTOP THING']),
  ...Array.from({ length: 2 }, () => ['QQRARE THING']),
]);
check('a word on almost everything is dropped', !lopsided.tokens.includes('thing'), lopsided.tokens.join(' '));
check('and so is one on almost nothing', !lopsided.tokens.includes('qqrare'));

console.log('\nthe space it builds:');

const names: string[] = [];
for (const f of readdirSync('test/fixtures').filter((n) => n.endsWith('.syx'))) {
  const b = readFileSync('test/fixtures/' + f);
  const body = b.subarray(6, b.length - 2);
  for (let i = 0; i < 32; i++) names.push(body.subarray(i * 128 + 118, i * 128 + 128).toString('ascii').trim());
}
const space = buildNameSpace(names.map((n) => [n]))!;
check('the factory banks produce a space', space !== null && space.dims > 1, `${space?.dims} dims`);
check('every voice has coordinates', space.coords.length === names.length * space.dims);
check('each component is scaled to about unit variance', (() => {
  for (let k = 0; k < space.dims; k++) {
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < names.length; i++) {
      const v = space.coords[i * space.dims + k];
      sum += v;
      sq += v * v;
    }
    const variance = sq / names.length - (sum / names.length) ** 2;
    if (!(variance > 0.5 && variance < 2)) return false;
  }
  return true;
})());
check('the components are named after their words',
  space.labels.every((l) => l.length > 0) && space.labels[0].includes('/'), space.labels[0]);

const distance = (a: number, b: number) => {
  let s = 0;
  for (let k = 0; k < space.dims; k++) {
    const d = space.coords[a * space.dims + k] - space.coords[b * space.dims + k];
    s += d * d;
  }
  return s;
};
const nearest = (name: string, count: number) => {
  const i = names.indexOf(name);
  return names
    .map((n, j) => [j, distance(i, j)] as [number, number])
    .filter(([j]) => j !== i && names[j] !== name)
    .sort((a, b) => a[1] - b[1])
    .slice(0, count)
    .map(([j]) => names[j]);
};

// The test that matters: things named alike end up near each other.
const pianoNear = nearest('PIANO   1', 4);
check('pianos are near pianos', pianoNear.every((n) => n.includes('PIANO')), pianoNear.join(' | '));
const organNear = nearest('E.ORGAN 1', 4);
check('organs are near organs', organNear.every((n) => n.includes('ORGAN') || n.includes('PIPES')), organNear.join(' | '));
const bassNear = nearest('BASS    1', 3);
check('basses are near basses', bassNear.every((n) => n.includes('BASS')), bassNear.join(' | '));
// Sound effects have no instrument word at all and still group, on the words
// they do have.
const fxNear = nearest('TAKE OFF', 3);
check('and the odd ones find each other', fxNear.some((n) => n === 'TRAIN' || n === 'LASERSWEEP'), fxNear.join(' | '));

check('a corpus with nothing to say produces no space',
  buildNameSpace([['INIT VOICE'], ['INIT VOICE'], ['INIT VOICE']]) === null);

console.log('\nand whether it is worth using:');

/*
 * The reason the store fits twice.
 *
 * A dozen name components are a dozen more chances to fit noise, and on
 * ratings that owe nothing to the names that costs real accuracy at the rating
 * counts a new user actually has. So the store fits both ways and keeps the
 * better one. These check that the choice comes out right at both ends - that
 * noise is rejected however little evidence there is, and that a signal no
 * audio feature carries is picked up.
 */
const trial = (namesMatter: boolean, rated: number) => {
  const N = 1200;
  const AUDIO = 30;
  const INSTR = ['PIANO', 'E.PIANO', 'ORGAN', 'BASS', 'BRASS', 'STRINGS', 'PAD', 'BELL', 'GUITAR', 'LEAD'];
  const ADJ = ['WARM', 'FAT', 'SOFT', 'BRIGHT', 'DARK', 'DIRTY', ''];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const gauss = () => {
    let s = 0;
    for (let i = 0; i < 6; i++) s += rnd();
    return (s - 3) / 1.2;
  };
  const docs: string[][] = [];
  const truth: number[] = [];
  const audio = new Float32Array(N * AUDIO);
  for (let i = 0; i < N; i++) {
    const instr = INSTR[Math.floor(rnd() * INSTR.length)];
    const adj = ADJ[Math.floor(rnd() * ADJ.length)];
    docs.push([`${adj} ${instr}`.trim().slice(0, 10)]);
    for (let d = 0; d < AUDIO; d++) audio[i * AUDIO + d] = gauss();
    // Half the signal in a word no feature can see, or none of it.
    const fromName = namesMatter
      ? (adj === 'WARM' ? 1.2 : 0) + (adj === 'DIRTY' ? -1.1 : 0) + (instr === 'ORGAN' ? 0.9 : 0)
      : 0;
    truth.push(3 + 0.8 * audio[i * AUDIO] - 0.5 * audio[i * AUDIO + 3] + fromName + 0.4 * gauss());
  }
  const built = buildNameSpace(docs)!;
  const rows = Array.from({ length: rated }, (_, i) => i);
  const ratings = rows.map((i) => truth[i]);
  const fit = (weight: number) => {
    const extra = weight > 0 ? built.dims : 0;
    const dim = AUDIO + extra;
    const data = new Float32Array(N * dim);
    for (let i = 0; i < N; i++) {
      for (let d = 0; d < AUDIO; d++) data[i * dim + d] = audio[i * AUDIO + d];
      for (let d = 0; d < extra; d++) data[i * dim + AUDIO + d] = built.coords[i * built.dims + d] * weight;
    }
    return fitTaste(data, dim, { rows, ratings })!;
  };
  return { audio: fit(0).r2, named: fit(1).r2 };
};

for (const rated of [60, 400]) {
  const noise = trial(false, rated);
  check(`${rated} ratings: noise in the names is rejected`, noise.named < noise.audio,
    `audio ${noise.audio.toFixed(3)} vs named ${noise.named.toFixed(3)}`);
  const signal = trial(true, rated);
  check(`${rated} ratings: signal in the names is picked up`, signal.named > signal.audio + 0.02,
    `audio ${signal.audio.toFixed(3)} vs named ${signal.named.toFixed(3)}`);
}

console.log('\nthe pull on families:');

/*
 * The point of all this: a shared name draws two voices together a little.
 *
 * A person naming two patches the same thing is direct evidence about
 * perception, which the feature vector only ever approximates. But it is a
 * hint and not a verdict, so what has to hold is that it moves a pair the
 * measurements already nominated, and cannot reach one they did not.
 */
const graph = {
  n: 244,
  //     0-1 just outside the threshold, 2-3 far outside
  a: Int32Array.from([0, 2]),
  b: Int32Array.from([1, 3]),
  d: Float32Array.from([0.34, 0.9]),
  featureScale: 1, paramScale: 1, featureWeight: 1, paramWeight: 1, blocks: 1, truncated: false,
};
/*
 * The corpus around the four matters, because the weighting is relative: a
 * word earns its pull by being rare. "Fat" is two voices in a thousand in the
 * real archives and carries a lot; in a four-voice fixture it would be half of
 * everything and carry almost nothing. So the four sit in a crowd.
 */
const crowd: string[][] = [];
for (let i = 0; i < 240; i++) crowd.push([['PIANO', 'STRINGS', 'ORGAN', 'BELL'][i % 4] + ' ' + (i % 9)]);
const named = buildNameSpace([
  ['FAT BASS'], ['FAT TBONE'], ['WASP STING'], ['EVOLUTION'],
  ...crowd,
], { vocabulary: { minVoices: 2 } })!;
const close = (x: number, y: number) => nameSimilarity(named.vectors, x, y);
check('two patches a person called fat agree', close(0, 1) > 0.3, close(0, 1).toFixed(2));
check('two patches with nothing in common do not', close(2, 3) === 0);

// A weak overlap is not weak evidence, it is a different word doing the
// matching, so it has to count for nothing rather than for a little.
const floored = nameCloseness(named.vectors);
check('a clear agreement survives the floor', floored(0, 1) === close(0, 1));
check('a weak one is discarded rather than scaled down',
  nameCloseness(named.vectors, 1.01)(0, 1) === 0);

const same = (c: NearDupeClusters, x: number, y: number) => c.labels[x] === c.labels[y];
const without = clusterAtThreshold(graph, 0.3);
check('without the hint the near pair stays apart', !same(without, 0, 1));
const withHint = clusterAtThreshold(graph, 0.3, floored, NAME_PULL);
check('with it they group', same(withHint, 0, 1));
check('and the far pair is still not reachable', !same(withHint, 2, 3));
check('and exactly one pair was joined, not a cascade',
  withHint.clusterCount === graph.n - 1, `${withHint.clusterCount} groups of ${graph.n}`);

// The dial has to actually turn it off.
const off = clusterAtThreshold(graph, 0.3, floored, 0);
check('the shipped floor is a real one', NAME_MIN_AGREEMENT > 0.5 && NAME_MIN_AGREEMENT <= 1);
check('a pull of zero is the old behaviour', !same(off, 0, 1));

console.log(fail === 0 ? '\nall name checks passed' : `\n${fail} check(s) failed`);
process.exit(fail === 0 ? 0 : 1);
