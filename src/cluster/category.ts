/*
 * Sound categories.
 *
 * Two levels. The top level is what the allocation floors and ceilings work in
 * and what the finished bank is ordered by, so it stays small enough to reason
 * about. Subcategories sit underneath for colouring, filtering and searching,
 * where more resolution costs nothing.
 *
 * This is deliberately a legible rule-based scorer rather than an unsupervised
 * clustering. Unsupervised clusters rarely land on musical categories, and when
 * they are wrong there is nothing to adjust. Every term below is a stated
 * assumption the user can see on the map view and change.
 *
 * Patch names are used only as a weak prior at the top level. In these archives
 * a name is as often noise as signal, so a keyword match nudges a score, it does
 * not set it. Subcategories are a different matter: once the top level is
 * settled, the name is usually the only thing that separates a Rhodes from a
 * Wurlitzer, so subcategory assignment leans on it heavily.
 */
import type { AcousticFeatures } from '../features/acoustic.ts';
import type { StructuralFeatures } from '../features/structural.ts';

/**
 * Bumped whenever the rules or the category list change. Categories are a pure
 * function of features that are already stored, so a bump recomputes them from
 * the database rather than forcing a re-render of the whole corpus.
 */
export const CATEGORIZER_VERSION = 2;

export const CATEGORIES = [
  'keys',
  'bells',
  'plucked',
  'bass',
  'brass',
  'lead',
  'organ',
  'strings',
  'abstract',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  keys: 'keys',
  bells: 'tuned percussion & bells',
  plucked: 'plucked & struck',
  bass: 'bass',
  brass: 'brass & reed',
  lead: 'lead',
  organ: 'organ',
  strings: 'strings & pad',
  abstract: 'abstract texture',
};

/** Weak name priors, matched as substrings against the lowercased name. */
export const CATEGORY_KEYWORDS: Record<Category, string[]> = {
  keys: ['piano', 'pno', 'rhodes', 'rhode', 'e.p', 'ep ', 'epiano', 'wurl', 'clav', 'harpsi',
    'hpschd', 'keys', 'keyboard', 'celeste', 'honky', 'grand', 'upright', 'dx7ep', 'tine'],
  bells: ['bell', 'chime', 'vibe', 'vibra', 'marimba', 'glock', 'kalimba', 'gamelan', 'tubular',
    'xylo', 'celest', 'steel drum', 'steeldrum', 'carillon', 'gong', 'music box',
    'musicbox', 'crystal', 'metal'],
  plucked: ['guitar', 'gtr', 'harp ', 'harp1', 'harp2', 'koto', 'sitar', 'pluck', 'banjo', 'lute',
    'pizz', 'zither', 'mandolin', 'balalaika', 'shamisen', 'nylon', 'steel str', 'ukulele'],
  bass: ['bass', 'basse', 'sub', 'contra', 'upright bs', 'fretless', 'slap'],
  brass: ['brass', 'horn', 'trumpet', 'tpt', 'trombone', 'tuba', 'sax', 'oboe', 'clarinet',
    'bassoon', 'reed', 'flute', 'flt', 'piccolo', 'recorder', 'shakuhachi', 'pan flute',
    'panflute', 'harmonica', 'accord', 'bagpipe', 'fanfare'],
  lead: ['lead', 'solo', 'syn-lead', 'synlead', 'mono', 'portamento', 'whistle', 'saw lead',
    'square lead', 'ld ', 'moog'],
  organ: ['organ', 'orgue', 'hammond', 'tonewheel', 'leslie', 'pipes', 'pipe org', 'church',
    'drawbar', 'b-3', 'b3 ', 'percussive org'],
  strings: ['string', 'strg', 'str ', 'violin', 'viola', 'cello', 'orch', 'symph', 'ensemble',
    'pad', 'choir', 'chorus', 'voice', 'vox', 'vocal', 'aah', 'ooh', 'warm', 'soft pad',
    'sweep pad', 'air', 'atmos'],
  abstract: ['fx', 'effect', 'sfx', 'noise', 'wind', 'space', 'sci', 'ufo', 'laser', 'weird',
    'random', 'drone', 'motor', 'train', 'jet', 'siren', 'alarm', 'thunder', 'rain', 'ocean',
    'helicopt', 'machine', 'robot', 'zap', 'blip', 'sweep', 'whoosh', 'take off', 'explosion'],
};

// ------------------------------------------------------------ subcategories

export interface SubcategoryDef {
  id: string;
  label: string;
  keywords: string[];
  /** Optional acoustic evidence, 0..1, used when no keyword matches. */
  test?: (a: AcousticFeatures, s: StructuralFeatures) => number;
}

const ramp = (x: number, lo: number, hi: number): number => {
  if (hi === lo) return x >= hi ? 1 : 0;
  const t = (x - lo) / (hi - lo);
  return t < 0 ? 0 : t > 1 ? 1 : t;
};

/** 1 inside [loFull, hiFull], falling to 0 at lo and hi. */
const band = (x: number, lo: number, loFull: number, hiFull: number, hi: number): number => {
  if (x < loFull) return ramp(x, lo, loFull);
  if (x > hiFull) return 1 - ramp(x, hiFull, hi);
  return 1;
};

/**
 * The first entry in each list is the fallback when nothing else matches, so it
 * should be the most generic member of the group.
 */
export const SUBCATEGORIES: Record<Category, SubcategoryDef[]> = {
  keys: [
    { id: 'piano', label: 'piano', keywords: ['piano', 'pno', 'grand', 'upright', 'honky', 'toy pian'] },
    { id: 'epiano', label: 'electric piano', keywords: ['e.p', 'ep ', 'epiano', 'e piano', 'rhodes', 'rhode', 'wurl', 'tine', 'dx7ep', 'e.grand'],
      test: (a) => ramp(a.logReleaseTime, -1.2, -0.2) * (1 - ramp(a.inharmonicity, 0.1, 0.4)) },
    { id: 'clav', label: 'clav & harpsichord', keywords: ['clav', 'harpsi', 'hpschd', 'cembalo', 'spinet'],
      test: (a) => ramp(a.centroidOct, 2.5, 5) * (1 - a.sustainRatio) },
    { id: 'keyperc', label: 'keyed percussion', keywords: ['celeste', 'celest', 'toy', 'music box', 'musicbox'] },
  ],
  bells: [
    { id: 'bell', label: 'bell', keywords: ['bell', 'chime', 'carillon', 'tubular', 'church'] },
    { id: 'mallet', label: 'mallet', keywords: ['marimba', 'vibe', 'vibra', 'xylo', 'glock', 'kalimba', 'balafon', 'gamelan', 'steel drum', 'steeldrum'],
      test: (a) => (1 - ramp(a.logReleaseTime, -0.8, 0.2)) * (1 - ramp(a.inharmonicity, 0.2, 0.6)) },
    { id: 'metallic', label: 'metallic', keywords: ['metal', 'gong', 'anvil', 'clang', 'tine bell'],
      test: (a) => ramp(a.inharmonicity, 0.35, 0.8) },
    { id: 'glass', label: 'glass & crystal', keywords: ['crystal', 'glass', 'ice', 'star'],
      test: (a) => ramp(a.centroidOct, 3, 6) * ramp(a.logReleaseTime, -0.3, 0.4) },
  ],
  plucked: [
    { id: 'guitar', label: 'guitar', keywords: ['guitar', 'gtr', 'nylon', 'steel str', 'folk', 'jazz gui', 'clas.gui', 'ukulele', 'banjo'] },
    { id: 'harp', label: 'harp', keywords: ['harp'] },
    { id: 'world', label: 'world strings', keywords: ['koto', 'sitar', 'shamisen', 'balalaika', 'lute', 'zither', 'mandolin', 'oud'] },
    { id: 'pluck', label: 'synth pluck', keywords: ['pluck', 'pizz', 'blip'],
      test: (a) => (1 - a.sustainRatio) * (1 - ramp(a.logReleaseTime, -1.4, -0.5)) },
  ],
  bass: [
    { id: 'synthbass', label: 'synth bass', keywords: ['syn', 'synth', 'moog', 'sub', 'square', 'saw'] },
    { id: 'acousticbass', label: 'acoustic bass', keywords: ['upright', 'acoustic', 'contra', 'string bass', 'wood'] },
    { id: 'ebass', label: 'electric bass', keywords: ['e.bass', 'e bass', 'ebass', 'fretless', 'slap', 'pick', 'finger', 'funk'] },
  ],
  brass: [
    { id: 'brass', label: 'brass', keywords: ['brass', 'horn', 'trumpet', 'tpt', 'trombone', 'tuba', 'fanfare', 'cornet'] },
    { id: 'reed', label: 'reed', keywords: ['sax', 'oboe', 'clarinet', 'bassoon', 'reed', 'harmonica', 'accord', 'bagpipe'] },
    { id: 'wind', label: 'flute & whistle', keywords: ['flute', 'flt', 'piccolo', 'recorder', 'shakuhachi', 'pan', 'ocarina', 'whistl'],
      test: (a) => (1 - ramp(a.centroidOct, 1.2, 3)) * a.sustainRatio },
  ],
  lead: [
    { id: 'synthlead', label: 'synth lead', keywords: ['lead', 'ld ', 'moog', 'saw', 'square', 'syn'] },
    { id: 'softlead', label: 'soft lead', keywords: ['soft', 'mellow', 'warm', 'whistle', 'sine'],
      test: (a) => 1 - ramp(a.centroidOct, 1.5, 3.5) },
    { id: 'hardlead', label: 'hard lead', keywords: ['hard', 'harsh', 'metal', 'heavy', 'distort', 'rock', 'screa'],
      test: (a) => ramp(a.centroidOct, 3, 5.5) },
  ],
  organ: [
    { id: 'electricorgan', label: 'electric organ', keywords: ['hammond', 'tonewheel', 'leslie', 'drawbar', 'b-3', 'b3 ', 'e.organ', 'e organ', 'jazz org', 'rock org', 'combo'] },
    { id: 'pipeorgan', label: 'pipe organ', keywords: ['pipe', 'church', 'cathedral', 'positif', 'diapason', 'tutti'] },
    { id: 'reedorgan', label: 'reed organ', keywords: ['reed org', 'harmonium', 'accord', 'calliope', 'caliope'] },
  ],
  strings: [
    { id: 'strings', label: 'strings', keywords: ['string', 'strg', 'str ', 'violin', 'viola', 'cello', 'orch', 'symph', 'ensemble'] },
    { id: 'pad', label: 'pad', keywords: ['pad', 'warm', 'soft', 'atmos', 'air', 'sweep pad', 'dream'],
      test: (a) => ramp(a.logAttackTime, -1.2, -0.3) * a.sustainRatio },
    { id: 'choir', label: 'choir & voice', keywords: ['choir', 'chorus', 'voice', 'vox', 'vocal', 'aah', 'ooh', 'humm', 'angel'] },
  ],
  abstract: [
    { id: 'fx', label: 'effects', keywords: ['fx', 'effect', 'sfx', 'zap', 'laser', 'siren', 'alarm', 'explosion', 'take off', 'jet', 'train', 'helicopt', 'motor', 'machine', 'robot'] },
    { id: 'drone', label: 'drone', keywords: ['drone', 'space', 'atmos', 'dark', 'deep'],
      test: (a) => a.sustainRatio * ramp(a.logReleaseTime, -0.5, 0.3) },
    { id: 'percussion', label: 'percussion', keywords: ['drum', 'snare', 'tom', 'kick', 'timpani', 'perc', 'clap', 'cymbal', 'hat'],
      test: (a) => (1 - a.sustainRatio) * ramp(a.flatness, 0.05, 0.3) },
    { id: 'noise', label: 'noise & sweep', keywords: ['noise', 'wind', 'rain', 'ocean', 'thunder', 'whoosh', 'sweep', 'wash'],
      test: (a) => ramp(a.flatness, 0.08, 0.4) },
  ],
};

export interface CategoryScores {
  best: Category;
  /** Subcategory id within `best`. */
  sub: string;
  /** Score per category, in CATEGORIES order. */
  scores: number[];
  /** Best score minus runner-up. Low means the classifier is unsure. */
  confidence: number;
  /** True when a name keyword contributed to the winning score. */
  nameMatched: boolean;
}

export function subcategoryLabel(category: Category, sub: string): string {
  return SUBCATEGORIES[category]?.find((s) => s.id === sub)?.label ?? sub;
}

/** How strongly a name suggests each category. */
export function nameScores(name: string): number[] {
  const n = name.toLowerCase();
  return CATEGORIES.map((c) => (CATEGORY_KEYWORDS[c].some((k) => n.includes(k)) ? 1 : 0));
}

/**
 * Weight given to a matching name keyword, relative to the acoustic terms,
 * which run to roughly 4. High enough to break a tie between two categories the
 * audio cannot separate - synth brass really does sound plucked - and low
 * enough that a confidently wrong name does not override clear evidence.
 */
export const NAME_PRIOR_WEIGHT = 1.6;

/**
 * Per-category overrides of the name prior.
 *
 * `lead` is not an acoustic category at all - a lead is whatever you play the
 * melody on, and acoustically it overlaps completely with pads, brass and
 * organs. No combination of attack, brightness and sustain separates it, and
 * trying to invent one only mislabels pads. But "LEAD" in a DX7 patch name is a
 * deliberate statement of intent by whoever made it, so for this one category
 * the name is allowed to outweigh the audio.
 */
export const CATEGORY_NAME_PRIOR: Partial<Record<Category, number>> = {
  lead: 3.0,
};

function pickSubcategory(category: Category, name: string, a: AcousticFeatures, s: StructuralFeatures): string {
  const defs = SUBCATEGORIES[category];
  if (!defs || defs.length === 0) return '';
  const n = name.toLowerCase();
  let best = defs[0].id;
  let bestScore = -Infinity;
  for (const def of defs) {
    // A keyword hit is decisive here: at this point the top-level group is
    // already settled, and inside a group the name is usually the only thing
    // that tells a Rhodes from a Wurlitzer.
    const keyword = def.keywords.some((k) => n.includes(k)) ? 2 : 0;
    const acoustic = def.test ? def.test(a, s) : 0;
    const score = keyword + acoustic;
    if (score > bestScore) {
      bestScore = score;
      best = def.id;
    }
  }
  return best;
}

export function categorize(a: AcousticFeatures, s: StructuralFeatures, name: string): CategoryScores {
  // ---- shared shapes ----
  // logAttackTime is log10 seconds: -2 is 10 ms, -1 is 100 ms, -0.5 is ~316 ms.
  const fastAttack = 1 - ramp(a.logAttackTime, -2.2, -1.2);
  const midAttack = band(a.logAttackTime, -2.2, -1.7, -0.9, -0.4);
  const slowAttack = ramp(a.logAttackTime, -1.4, -0.5);
  const percussive = 1 - a.sustainRatio;
  const sustained = a.sustainRatio;
  const longRelease = ramp(a.logReleaseTime, -1.0, 0.3);
  const shortRelease = 1 - ramp(a.logReleaseTime, -1.5, -0.6);
  const veryShortRelease = 1 - ramp(a.logReleaseTime, -2.0, -1.2);
  const bright = ramp(a.centroidOct, 0.6, 3.5);
  // Absolute brightness and register are what separate a bass from anything
  // else: brightness relative to f0 is deliberately register-independent, so it
  // cannot see that a patch sounds two octaves below the note you played.
  const absDark = 1 - ramp(a.absBrightness, -1.5, 1.5);
  const lowRegister = ramp(-a.registerOct, 0.4, 2.0);
  const clangy = ramp(a.inharmonicity, 0.15, 0.6);
  const tonal = 1 - clangy;
  const darkening = ramp(-a.centroidSlope, 0.1, 1.5);
  const brightening = ramp(a.centroidSlope, 0.15, 1.5);
  const velBright = ramp(a.velBrightnessOct, 0.3, 2.0);
  const velLoud = ramp(a.velLevelDb, 4, 20);
  const noisy = ramp(a.flatness, 0.02, 0.3);
  const lowHeavy = ramp(-a.keyLevelSlope, 0.5, 6);
  const wildPitch = Math.max(ramp(s.pitchEgDepth, 25, 120), ramp(s.lfoPmDepth, 40, 99), s.lfoSampleHold);
  // An organ holds flat and dead level: no velocity response, no decay, and it
  // stops the moment you let go.
  const noVelocity = 1 - ramp(a.velLevelDb, 1.5, 8);
  const flatHold = ramp(a.sustainRatio, 0.75, 0.95);
  // A lead is monophonic-shaped: one carrier doing the work, strong sustain.
  const fewCarriers = 1 - ramp(s.carriers, 1, 3);

  const raw: Record<Category, number> = {
    keys:
      1.4 * fastAttack + 1.2 * percussive + 0.9 * tonal + 0.7 * darkening +
      0.5 * velLoud + 0.4 * band(a.centroidOct, 0, 0.6, 2.6, 4.5) - 1.0 * slowAttack,
    bells:
      1.7 * clangy + 1.0 * fastAttack + 0.9 * percussive + 1.0 * longRelease +
      0.6 * bright - 0.8 * slowAttack,
    plucked:
      1.3 * fastAttack + 1.4 * percussive + 1.0 * tonal + 0.9 * shortRelease +
      0.5 * darkening - 1.0 * slowAttack - 0.6 * clangy - 0.9 * sustained,
    bass:
      1.6 * lowRegister + 1.2 * absDark + 0.8 * lowHeavy + 0.6 * tonal +
      0.4 * (s.transpose < 0 ? 1 : 0) - 0.8 * slowAttack,
    brass:
      0.9 * midAttack + 0.5 * fastAttack + 1.3 * sustained + 1.1 * velBright +
      0.8 * brightening + 0.5 * tonal - 0.7 * clangy - 0.5 * lowRegister,
    lead:
      // Leads are not penalised much for a slow attack: a swelling synth lead is
      // a common shape, and what separates it from a pad is that it is one or
      // two carriers doing bright, sustained, monophonic-shaped work.
      1.4 * fewCarriers + 1.2 * sustained + 0.9 * bright + 0.6 * velBright +
      0.5 * tonal - 0.8 * percussive - 0.2 * slowAttack - 0.5 * lowRegister,
    organ:
      1.5 * flatHold + 1.2 * noVelocity + 1.0 * fastAttack + 0.9 * veryShortRelease +
      0.6 * tonal - 1.0 * slowAttack - 0.8 * percussive,
    strings:
      1.5 * slowAttack + 1.4 * sustained + 0.9 * longRelease + 0.8 * tonal +
      0.4 * (1 - bright) - 1.0 * percussive,
    abstract:
      1.2 * noisy + 1.1 * wildPitch + 1.0 * clangy + 0.8 * clangy * bright +
      0.7 * ramp(Math.abs(a.centroidSlope), 1.5, 6) + 0.5 * ramp(s.lfoAmDepth, 40, 99),
  };

  const nm = nameScores(name);
  const scores = CATEGORIES.map((c, i) => raw[c] + (CATEGORY_NAME_PRIOR[c] ?? NAME_PRIOR_WEIGHT) * nm[i]);

  let bestIx = 0;
  let secondBest = -Infinity;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bestIx]) bestIx = i;
  for (let i = 0; i < scores.length; i++) if (i !== bestIx && scores[i] > secondBest) secondBest = scores[i];

  const best = CATEGORIES[bestIx];
  return {
    best,
    sub: pickSubcategory(best, name, a, s),
    scores,
    confidence: scores[bestIx] - secondBest,
    nameMatched: nm[bestIx] > 0,
  };
}
