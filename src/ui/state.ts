/*
 * Application state.
 *
 * Everything expensive lives here in memory and is mirrored into IndexedDB, so
 * a session survives a reload at any point: after ingest, after the analysis
 * pass, after clustering, and after every single rating.
 */
import {
  addVoices, clearAll, clearRatings, deleteRating, getAllFeatures, getAllFeaturesPaged, getAllRatings,
  getAllVoices, getAllVoicesPaged, kvGet, kvSet,
  putFeatures, putRating, setPinned,
  type FeatureRecord, type RatingRecord, type VoiceRecord, type VoiceSource,
} from '../db/store.ts';
import { clampVoice, packVoice, packedKeyOf, unpackVoice, voiceName, setVoiceName, INIT_VOICE_PARAMS } from '../sysex/voice.ts';
import { buildBank, BANK_FILE_SIZE } from '../sysex/write.ts';
import { parseSysexFile, type ParseReport } from '../sysex/parse.ts';
import { isCarrier } from '../engine/fmcore.ts';
import { isInitVoice, isSilentByParams } from '../sysex/voice.ts';
import { ANALYSIS_VERSION, fitStandardizer, standardize, FEATURE_COUNT, FEATURE_DEFS, type Standardizer } from '../features/vector.ts';
import type { DupeRequest, DupeResponse } from '../workers/nearDupe.worker.ts';
import { clusterAtThreshold, chooseRepresentatives, thresholdSweep, type NearDupeGraph, type NearDupeClusters, type SweepRow } from '../cluster/nearDupe.ts';
import { pca } from '../cluster/pca.ts';
import { buildNameSpace, nameCloseness, NAME_PULL, type NameSpace } from '../cluster/nameSpace.ts';
import { fitWhitener, whitenAll, redundancyRatio, redundancyWeights, type Whitener } from '../cluster/whiten.ts';
import { fitTaste, predictRating, tasteWeights, type TasteModel } from '../cluster/taste.ts';
import { lda } from '../cluster/lda.ts';
import { CATEGORIES, CATEGORIZER_VERSION, categorize, type Category } from '../cluster/category.ts';
import type { AcousticFeatures } from '../features/acoustic.ts';
import type { StructuralFeatures } from '../features/structural.ts';
import { analyzeAll, type PoolProgress } from '../workers/pool.ts';
import { isZip, extractZip } from '../util/zip.ts';
import { runTask, type TaskHandle } from './task.ts';

import { applyResult, newStanding, ratingOffset, type Standing } from '../rank/elo.ts';

/**
 * Let the browser paint before starting something that blocks the thread.
 *
 * A progress bar set immediately before a synchronous five-second PCA never
 * appears: the assignment happens, the frame never runs, and the user watches
 * the previous stage for the whole of the next one.
 */
function yieldToPaint(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * Told how far along a long job is, and given the chance to let the page draw.
 *
 * Returning a promise is the point: the caller awaits it, which is what
 * actually hands the thread back.
 */
export type SliceCallback = (done: number, total: number) => Promise<void> | void;

/** How long to hold the thread before offering it back, in milliseconds. */
const SLICE_MS = 12;

/**
 * When to refit the taste model, as a fraction of what it was fitted on, and
 * the fewest new ratings that can ever trigger one.
 */
const REFIT_FRACTION = 0.25;
const REFIT_FLOOR = 10;

function fmtCount(n: number): string {
  return n.toLocaleString('en-GB');
}

/*
 * Base64 in chunks.
 *
 * `String.fromCharCode(...bytes)` on a whole corpus overflows the argument
 * limit and throws; forty thousand voices go through here one at a time
 * anyway, so the chunking only matters for safety.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

function base64ToBytes(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface LoadedVoice {
  id: number;
  name: string;
  unpacked: Uint8Array;
  packed: Uint8Array;
  sources: VoiceSource[];
  pinned: boolean;
  userSupplied: boolean;
  clampedBytes: number;
}

export interface Analysis {
  acoustic: Omit<AcousticFeatures, 'segments'>;
  structural: StructuralFeatures;
  vector: Float32Array;
  category: Category;
  subcategory: string;
  categoryConfidence: number;
  silent: boolean;
}

export interface IngestSummary {
  files: number;
  voicesRead: number;
  added: number;
  merged: number;
  rejected: number;
  clampedBytes: number;
  checksumFailures: number;
  skipped: Array<{ reason: string; count: number }>;
  errors: Array<{ file: string; error: string }>;
}

type Listener = () => void;

const VOICE_EXTENSIONS = /\.(syx|dx7|bin|dmp|vce|snd|raw)$/i;

export class Store {
  voices: LoadedVoice[] = [];
  indexById = new Map<number, number>();
  analysis: Array<Analysis | null> = [];
  standardizer: Standardizer | null = null;
  /** Standardised vectors, n * FEATURE_COUNT, row-major. */
  flat: Float32Array | null = null;

  /*
   * What the names say, and the two matrices that carry it.
   *
   * A DX7 name is ten characters somebody chose on purpose, and until now it
   * reached exactly one place: a keyword nudged the category and nothing else
   * ever looked. That is a whole axis thrown away. "LEAD" is an intention no
   * spectrum analysis recovers, "ORGAN" separates two things the features
   * genuinely confuse, and the words carrying the most taste - warm, fat,
   * soft, dirty - have no acoustic definition at all.
   *
   * cluster/nameSpace.ts reduces the words to about a dozen dense components.
   * They are appended to the audio features to make the `semantic` space, and
   * that is what the model learns in and what neighbourhoods are measured in.
   *
   * Not near-duplicate detection, though, and this is the one hard line. Two
   * archives naming the same patch differently still have to merge, and two
   * unrelated patches both called BASS 1 still have to stay apart. Dedupe goes
   * on measuring the audio alone: `distanceSpace` never sees any of this.
   */
  nameSpace: NameSpace | null = null;
  /** Audio features with the name components appended. */
  semantic: Float32Array | null = null;
  /** The same, whitened, for the neighbour search. */
  semanticNeighbour: Float32Array | null = null;
  /** Width of both. FEATURE_COUNT when there are no usable names. */
  semanticDim = FEATURE_COUNT;
  /**
   * The same vectors, whitened, and weighted by what the ratings care about.
   *
   * This is what every distance is measured in - near-duplicates, cluster
   * representatives, the ordering of the final bank. `flat` stays unwhitened
   * because PCA and the map axes want the raw variance structure.
   */
  whitened: Float32Array | null = null;
  whitener: Whitener | null = null;
  tasteModel: TasteModel | null = null;
  /** Predictions, filled in as they are asked for and dropped when stale. */
  private predicted: Float32Array | null = null;
  private predictedDone: Uint8Array | null = null;
  /** How much redundancy the whitening removed; 1 means none. */
  redundancy = 1;
  /** 0 disables taste weighting of distances, 1 applies it fully. */
  tasteStrength = 1;
  /**
   * How much the words in a name count against the sound of the patch.
   *
   * 1 puts a name component on the same footing as an audio feature, which
   * with a dozen of them against sixty-odd features means the names decide
   * roughly a sixth of where a patch sits. 0 turns the whole thing off and
   * gets the behaviour this app had before names were read at all - worth
   * keeping, because an archive of INIT VOICE copies and slot numbers has
   * nothing to say and a corpus of carefully named patches has a great deal.
   */
  nameWeight = 1;
  /** Whether the fitted model is the one that reads names. */
  tasteUsesNames = false;
  /** What reading them was worth, in R-squared, the last time it was tried. */
  nameGain = 0;
  graph: NearDupeGraph | null = null;
  /**
   * The looser of the two thresholds: groups voices into families that get a
   * face-off, where members are similar but still audibly different.
   *
   * Both defaults come from reading the sweep on a real 35,000-voice corpus
   * rather than from first principles, and they are a good deal more
   * aggressive than the cautious numbers they replace. At 0.30 that corpus
   * falls from 35,000 voices to 17,778 families - roughly half of everything
   * is a near-relative of something else - which is the honest shape of a pile
   * of patches assembled from twenty overlapping collections.
   *
   * Being conservative here is not free: a threshold too tight leaves the same
   * sound in the rating queue nine times, and nine unnecessary judgements cost
   * far more than one family drawn slightly too wide.
   *
   * 0.30 is the top of the sweep table's range. If it ever wants to go looser,
   * SWEEP_POINTS in the Sources view needs more entries above it.
   */
  threshold = 0.3;
  /**
   * The tighter threshold. Anything below it is treated as the same patch:
   * merged silently, shown as one point on the map, and never face-offed,
   * because there would be nothing to hear.
   */
  mergeThreshold = 0.16;
  clusters: NearDupeClusters | null = null;
  /** One voice index per near-duplicate cluster. */
  representatives: number[] = [];
  mergeClusters: NearDupeClusters | null = null;
  mergeRepresentatives: number[] = [];
  ratings = new Map<number, RatingRecord>();
  categoryOverrides = new Map<number, Category>();
  /** Extra keepers chosen in a face-off, by cluster id. */
  faceoffExtras = new Map<number, number[]>();
  projection: Float32Array | null = null;
  pcaExplained: number[] = [];
  /** Category-separating axes; see cluster/lda.ts. */
  ldaProjection: Float32Array | null = null;
  ldaExplained: number[] = [];
  ldaReason = '';
  lastIngest: IngestSummary | null = null;
  busy: string | null = null;
  /**
   * Features stored by an older build whose vector had a different shape. They
   * are discarded rather than migrated - re-rendering is a couple of minutes
   * and guessing at missing dimensions would poison every distance.
   */
  staleFeatures = 0;

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  setBusy(label: string | null): void {
    this.busy = label;
    this.emit();
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Read the whole session back from IndexedDB.
   *
   * Reported stage by stage, because on a large corpus this is fifteen seconds
   * of work with four distinct phases in it and no natural sign of life: the
   * two bulk reads, the unpack, and a PCA plus LDA that block the thread
   * outright. Yielding between stages is what lets the bar paint at all.
   */
  async load(): Promise<void> {
    await runTask('loading the corpus', async (task) => {
      // Reading dominates, so it gets most of the bar: voices are the bigger
      // rows, features the bigger count.
      const voiceRows = await getAllVoicesPaged((done, total) => {
        task.set(total ? (done / total) * 0.45 : null, `${fmtCount(done)} voices`);
      });
      const featureRows = await getAllFeaturesPaged((done, total) => {
        task.set(total ? 0.45 + (done / total) * 0.3 : null, `${fmtCount(done)} analysed`);
      });
      const ratingRows = await getAllRatings();

      task.stage('unpacking');
      task.set(0.78);
      await yieldToPaint();

      this.voices = voiceRows.map(toLoaded);
      this.reindex();
      this.analysis = new Array(this.voices.length).fill(null);
      this.staleFeatures = 0;
      for (const f of featureRows) {
        const ix = this.indexById.get(f.voiceId);
        if (ix === undefined) continue;
        const a = toAnalysis(f);
        if (a) this.analysis[ix] = a;
        else this.staleFeatures++;
      }
      for (const r of ratingRows) this.ratings.set(r.voiceId, r);

      this.threshold = (await kvGet<number>('threshold')) ?? this.threshold;
      this.mergeThreshold = (await kvGet<number>('mergeThreshold')) ?? this.mergeThreshold;
      const overrides = (await kvGet<Array<[number, Category]>>('categoryOverrides')) ?? [];
      this.categoryOverrides = new Map(overrides);
      const extras = (await kvGet<Array<[number, number[]]>>('faceoffExtras')) ?? [];
      this.faceoffExtras = new Map(extras);
      const ranks = (await kvGet<Array<[number, number, number]>>('rankings')) ?? [];
      this.rankings = new Map(ranks.map(([id, score, games]) => [id, { score, games }]));

      if (this.analysisComplete) {
        // Categories are a pure function of features that are already stored,
        // so a change to the rules re-labels the corpus without re-rendering.
        const seen = await kvGet<number>('categorizerVersion');
        if (seen !== CATEGORIZER_VERSION) {
          task.stage('re-categorising');
          task.set(0.82);
          await yieldToPaint();
          await this.recategorizeAll();
        }
        task.stage('projecting the map');
        task.set(0.9);
        await yieldToPaint();
        this.rebuildDerived();

        const savedGraph = await kvGet<NearDupeGraph>('nearDupeGraph');
        if (savedGraph && savedGraph.n === this.voices.length) {
          task.stage('grouping near-duplicates');
          task.set(0.97);
          await yieldToPaint();
          this.graph = savedGraph;
          this.applyThreshold(this.threshold, this.mergeThreshold, false);
        }
      }
    });
    this.emit();
  }

  private reindex(): void {
    this.indexById.clear();
    this.voices.forEach((v, i) => this.indexById.set(v.id, i));
  }

  get analysisComplete(): boolean {
    return this.voices.length > 0 && this.analysis.every((a) => a !== null);
  }

  get analysedCount(): number {
    return this.analysis.reduce((n, a) => n + (a ? 1 : 0), 0);
  }

  /**
   * Recompute every category and subcategory from the stored features. Cheap
   * next to re-rendering, so the classifier can be changed freely.
   */
  async recategorizeAll(): Promise<void> {
    const records: FeatureRecord[] = [];
    for (let i = 0; i < this.voices.length; i++) {
      const a = this.analysis[i];
      if (!a) continue;
      const c = categorize(a.acoustic as never, a.structural, this.voices[i].name);
      a.category = c.best;
      a.subcategory = c.sub;
      a.categoryConfidence = c.confidence;
      records.push({
        voiceId: this.voices[i].id,
        analysisVersion: ANALYSIS_VERSION,
        acoustic: a.acoustic,
        structural: a.structural,
        vector: a.vector,
        category: c.best,
        subcategory: c.sub,
        categoryConfidence: c.confidence,
        silent: a.silent,
      });
    }
    await putFeatures(records);
    await kvSet('categorizerVersion', CATEGORIZER_VERSION);
  }

  subcategoryOf(index: number): string {
    return this.analysis[index]?.subcategory ?? '';
  }

  categoryOf(index: number): Category | null {
    const v = this.voices[index];
    if (!v) return null;
    return this.categoryOverrides.get(v.id) ?? this.analysis[index]?.category ?? null;
  }

  ratingOf(index: number): number | null {
    const v = this.voices[index];
    return v ? this.ratings.get(v.id)?.rating ?? null : null;
  }

  // ---------------------------------------------------------------- ingest

  /**
   * Read dropped files. Zip archives are unpacked in place, and anything that
   * does not look like voice data is reported rather than silently dropped.
   */
  async ingestFiles(
    files: File[],
    opts: { userSupplied?: boolean; pinned?: boolean; onProgress?: (label: string, done: number, total: number) => void } = {},
  ): Promise<IngestSummary> {
    return runTask(`reading ${fmtCount(files.length)} file${files.length === 1 ? '' : 's'}`,
      (task) => this.ingestInto(files, opts, task));
  }

  private async ingestInto(
    files: File[],
    opts: { userSupplied?: boolean; pinned?: boolean; onProgress?: (label: string, done: number, total: number) => void },
    task: TaskHandle,
  ): Promise<IngestSummary> {
    const summary: IngestSummary = {
      files: 0, voicesRead: 0, added: 0, merged: 0, rejected: 0,
      clampedBytes: 0, checksumFailures: 0, skipped: [], errors: [],
    };
    const skipTally = new Map<string, number>();
    /** Set per file and per archive entry, read by the handler below. */
    let fileDate = 0;
    let entryDate = 0;
    const pending: Array<Omit<VoiceRecord, 'id'>> = [];

    const handleBytes = (bytes: Uint8Array, name: string) => {
      let report: ParseReport;
      try {
        report = parseSysexFile(bytes, name);
      } catch (err) {
        summary.errors.push({ file: name, error: (err as Error).message });
        return;
      }
      for (const s of report.skipped) skipTally.set(s.reason, (skipTally.get(s.reason) ?? 0) + s.count);
      summary.files++;
      summary.voicesRead += report.voices.length;
      const at = entryDate > 0 ? entryDate : fileDate;
      const atFrom: 'archive' | 'file' = entryDate > 0 ? 'archive' : 'file';
      for (const raw of report.voices) {
        if (raw.checksumOk === false) summary.checksumFailures++;
        const unpacked = unpackVoice(raw.packed);
        const { changed } = clampVoice(unpacked);
        summary.clampedBytes += changed;
        if (isInitVoice(unpacked) || isSilentByParams(unpacked, isCarrier)) {
          summary.rejected++;
          continue;
        }
        const packed = packVoice(unpacked);
        pending.push({
          packedKey: packedKeyOf(packed),
          packed,
          unpacked,
          name: voiceName(unpacked),
          sources: [{
            file: raw.sourceFile,
            bank: raw.bank,
            slot: raw.slot,
            name: voiceName(unpacked),
            container: raw.container,
            checksumOk: raw.checksumOk,
            ...(at > 0 ? { at, atFrom } : {}),
          }],
          pinned: opts.pinned ?? false,
          clampedBytes: changed,
          userSupplied: opts.userSupplied ?? false,
        });
      }
    };

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      task.set(i / files.length, file.name);
      opts.onProgress?.(file.name, i, files.length);
      const bytes = new Uint8Array(await file.arrayBuffer());
      // A loose file's timestamp is usually the day it was downloaded, which
      // says nothing; an archive entry's is usually from whenever the pack was
      // put together, which is the only chronology these patches have. Both are
      // recorded, labelled differently, and the UI trusts them accordingly.
      fileDate = Number.isFinite(file.lastModified) ? file.lastModified : 0;
      if (isZip(bytes)) {
        const { files: inner, failed } = await extractZip(
          bytes,
          (name, size) => !name.endsWith('/') && size > 0 && (VOICE_EXTENSIONS.test(name) || size === 4104 || size === 163 || size % 4096 === 0),
          (done, total) => {
            // Inside an archive the entries are the real unit of work, so the
            // bar tracks those rather than sitting still on one "file".
            task.set(total ? (i + done / total) / files.length : i / files.length,
              `${file.name} — ${fmtCount(done)} of ${fmtCount(total)}`);
            opts.onProgress?.(`${file.name} (${done}/${total})`, i, files.length);
          },
        );
        for (const f of failed) summary.errors.push({ file: `${file.name}:${f.name}`, error: f.error });
        for (const f of inner) {
          entryDate = f.modified;
          handleBytes(f.bytes, `${file.name}/${f.name}`);
        }
        entryDate = 0;
      } else {
        handleBytes(bytes, file.name);
      }
    }

    task.stage('writing to the database');
    task.set(1);
    opts.onProgress?.('writing to the database', files.length, files.length);
    const { added, merged } = await addVoices(pending);
    summary.added = added;
    summary.merged = merged;
    summary.skipped = [...skipTally].map(([reason, count]) => ({ reason, count }));

    const rows = await getAllVoices();
    this.voices = rows.map(toLoaded);
    this.reindex();
    const previous = this.analysis;
    this.analysis = new Array(this.voices.length).fill(null);
    // Keep analysis for voices that were already there.
    const featureRows = await getAllFeatures();
    this.staleFeatures = 0;
    for (const f of featureRows) {
      const ix = this.indexById.get(f.voiceId);
      if (ix === undefined) continue;
      const a = toAnalysis(f);
      if (a) this.analysis[ix] = a;
      else this.staleFeatures++;
    }
    void previous;
    this.lastIngest = summary;
    this.graph = null;
    this.clusters = null;
    this.emit();
    return summary;
  }

  // -------------------------------------------------------------- analysis

  /** Render and analyse every voice that has no features yet. */
  async runAnalysis(opts: { onProgress?: (p: PoolProgress) => void; signal?: AbortSignal } = {}): Promise<void> {
    const jobs = this.voices
      .map((v, i) => ({ v, i }))
      .filter(({ i }) => this.analysis[i] === null)
      .map(({ v }) => ({ id: v.id, unpacked: v.unpacked }));
    if (jobs.length === 0) {
      this.rebuildDerived();
      this.emit();
      return;
    }

    // Cancellable from the progress bar whether or not the caller brought its
    // own signal, since the bar is the only stop button there is now.
    const own = new AbortController();
    const signal = opts.signal ?? own.signal;

    this.setBusy(`analysing ${jobs.length} voices`);
    try {
      await runTask(`analysing ${fmtCount(jobs.length)} voices`, (task) => analyzeAll(jobs, {
        onProgress: (p) => {
          task.set(p.total ? p.done / p.total : null, `${p.rate.toFixed(0)}/s`);
          opts.onProgress?.(p);
        },
        signal,
        onBatch: async (items) => {
          const records: FeatureRecord[] = [];
          for (const item of items) {
            const ix = this.indexById.get(item.id);
            if (ix === undefined) continue;
            this.analysis[ix] = {
              acoustic: item.acoustic as Analysis['acoustic'],
              structural: item.structural,
              vector: item.vector,
              category: item.category as Category,
              subcategory: item.subcategory,
              categoryConfidence: item.categoryConfidence,
              silent: item.silent,
            };
            records.push({
              voiceId: item.id,
              analysisVersion: ANALYSIS_VERSION,
              acoustic: item.acoustic,
              structural: item.structural,
              vector: item.vector,
              category: item.category,
              subcategory: item.subcategory,
              categoryConfidence: item.categoryConfidence,
              silent: item.silent,
            });
          }
          await putFeatures(records);
        },
      }), { cancel: () => own.abort() });

      if (this.analysisComplete) {
        await runTask('projecting the map', async (task) => {
          task.set(null, 'principal components');
          await yieldToPaint();
          this.rebuildDerived();
        });
      }
    } finally {
      this.setBusy(null);
    }
  }

  /**
   * Read every name a voice arrived under.
   *
   * All of them, not just the surviving one: the same patch is called SOFT EP
   * in one archive and RHODES MK1 in the next, and the two together say more
   * than either does. Agreement across archives is the strongest naming signal
   * this corpus has.
   */
  private nameDocs(): string[][] {
    return this.voices.map((v) => {
      const names = [v.name];
      for (const src of v.sources) if (src.name !== v.name) names.push(src.name);
      return names;
    });
  }

  /**
   * Build the semantic space: standardised audio, then the name components.
   *
   * The name block arrives already scaled to unit variance per column, which
   * is the same footing the standardised audio features are on, so `weight` is
   * a straight statement of how much the words count against the sound.
   */
  private buildSemantic(): void {
    const n = this.voices.length;
    if (!this.flat) return;
    const space = this.nameSpace;
    const extra = space && this.nameWeight > 0 ? space.dims : 0;
    this.semanticDim = FEATURE_COUNT + extra;

    const whitened = this.whitener
      ? whitenAll(this.flat, n, FEATURE_COUNT, this.whitener)
      : null;
    if (extra === 0) {
      this.semantic = this.flat;
      this.semanticNeighbour = whitened;
      return;
    }

    const dim = this.semanticDim;
    const semantic = new Float32Array(n * dim);
    const neighbour = new Float32Array(n * dim);
    for (let i = 0; i < n; i++) {
      const to = i * dim;
      const from = i * FEATURE_COUNT;
      for (let d = 0; d < FEATURE_COUNT; d++) {
        semantic[to + d] = this.flat[from + d];
        neighbour[to + d] = whitened ? whitened[from + d] : this.flat[from + d];
      }
      const nameFrom = i * space!.dims;
      for (let d = 0; d < extra; d++) {
        const v = space!.coords[nameFrom + d] * this.nameWeight;
        semantic[to + FEATURE_COUNT + d] = v;
        neighbour[to + FEATURE_COUNT + d] = v;
      }
    }
    this.semantic = semantic;
    this.semanticNeighbour = neighbour;
  }

  /** What a coefficient at this index is called. */
  featureLabel(index: number): string {
    if (!this.tasteUsesNames && index >= FEATURE_COUNT) return `feature ${index}`;
    if (index < FEATURE_COUNT) return FEATURE_DEFS[index]?.label ?? `feature ${index}`;
    const k = index - FEATURE_COUNT;
    const label = this.nameSpace?.labels[k];
    return label ? `named: ${label}` : `name component ${k + 1}`;
  }

  /** Standardise the vectors and compute the map projection. */
  rebuildDerived(): void {
    const vectors = this.analysis.map((a) => a?.vector).filter((v): v is Float32Array => !!v);
    if (vectors.length === 0) return;
    this.standardizer = fitStandardizer(vectors);
    const n = this.voices.length;
    const flat = new Float32Array(n * FEATURE_COUNT);
    for (let i = 0; i < n; i++) {
      const a = this.analysis[i];
      if (a) flat.set(standardize(a.vector, this.standardizer), i * FEATURE_COUNT);
    }
    this.flat = flat;
    this.whitener = fitWhitener(flat, n, FEATURE_COUNT);
    this.redundancy = redundancyRatio(this.whitener);
    // Names first: the model is fitted in the space they are part of.
    this.nameSpace = buildNameSpace(this.nameDocs(), {
      // The archive a voice came from, so a word that never leaves one
      // collection can be recognised as that collection's label.
      archivesOf: (i) => {
        const out: string[] = [];
        for (const src of this.voices[i]?.sources ?? []) {
          const cut = src.file.indexOf('/');
          out.push(cut > 0 ? src.file.slice(0, cut) : src.file);
        }
        return out;
      },
    });
    this.buildSemantic();
    this.refitTasteModel();
    this.applyWhitening();

    /*
     * The variation axes stay on the audio alone, and this was measured.
     *
     * Putting the name block into the projection is the obvious thing to try
     * and it does not work, for a reason that is structural rather than a
     * matter of tuning. PCA takes the directions of greatest variance, and the
     * audio block is sixty-odd correlated features whose variance piles up
     * into a few coherent directions; the name block is a dozen components
     * that are orthogonal by construction and carry one unit of variance each.
     * No name direction can out-vote an audio principal direction, at any
     * weight. Measured on twenty thousand voices: the names took 2% of the two
     * axes, left the layout indistinguishable, and dropped the variance
     * explained from 18.7% to 7.3% purely by enlarging the denominator.
     *
     * And if the weighting were forced up far enough to matter, the result
     * would be worse than useless - name coordinates are discrete, so every
     * patch sharing a set of words sits at exactly one point, and an axis
     * driven by them stripes the map into bands.
     *
     * Where names do belong is the category axes below, which separate labelled
     * groups rather than chase variance.
     */
    const pcaWeights = redundancyWeights(flat, n, FEATURE_COUNT);
    const forPca = new Float32Array(n * FEATURE_COUNT);
    for (let i = 0; i < n; i++) {
      const base = i * FEATURE_COUNT;
      for (let d = 0; d < FEATURE_COUNT; d++) forPca[base + d] = flat[base + d] * pcaWeights[d];
    }
    const p = pca(forPca, n, FEATURE_COUNT, 2);
    this.projection = p.projection;
    this.pcaExplained = p.explained;

    const labels = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const c = this.categoryOf(i);
      if (c) labels[i] = CATEGORIES.indexOf(c);
    }
    /*
     * The category axes do get the names.
     *
     * LDA is not looking for variance, it is looking for directions that pull
     * labelled groups apart, so a dozen small orthogonal components are not
     * out-voted the way they are in PCA - they are used exactly where they
     * separate something. Which is the honest use for a word: `lead` is not a
     * sound, it is a statement about what the patch is for, and no
     * arrangement of attack and brightness recovers it.
     *
     * The circularity is worth naming. Categories are assigned partly from
     * name keywords, so separating them in a space that includes name
     * components will always look good, and some of that is the labelling rule
     * being reflected back. It is partial - the acoustic terms outweigh the
     * name prior in the categoriser - and the axes are read as "where the
     * kinds of sound sit", which is what they now do better, not as evidence
     * that the categories are correct.
     */
    const ldaData = this.semantic ?? flat;
    const ldaDim = this.semantic ? this.semanticDim : FEATURE_COUNT;
    const l = lda(ldaData, n, ldaDim, labels, CATEGORIES.length, 2);
    this.ldaProjection = l.ok ? l.projection : null;
    this.ldaExplained = l.explained;
    this.ldaReason = l.reason ?? '';
  }

  /**
   * Recompute the whitened matrix. Cheap enough to redo whenever the taste
   * model or its strength changes.
   */
  applyWhitening(): void {
    if (!this.flat || !this.whitener) return;
    const weights = this.tasteModel
      ? tasteWeights(this.tasteModel, FEATURE_COUNT, this.tasteStrength)
      : undefined;
    this.whitened = whitenAll(this.flat, this.voices.length, FEATURE_COUNT, this.whitener, weights);
  }

  /** Fit the rating model, if there are enough ratings to be worth it. */
  refitTasteModel(): TasteModel | null {
    if (!this.flat) return null;
    const rows: number[] = [];
    const ratings: number[] = [];
    for (let i = 0; i < this.voices.length; i++) {
      const r = this.ratings.get(this.voices[i].id);
      if (r && this.analysis[i]) {
        rows.push(i);
        /*
         * The refined rating, so the ranking pass teaches the model too.
         *
         * Stars alone give it five values to learn from, and by the time the
         * top band matters most they have all collapsed onto one of them. The
         * order settled by comparison is real information about what you
         * prefer - it is the only information there is *within* a band - and a
         * model that never sees it cannot predict the distinction the ranking
         * exists to draw.
         */
        ratings.push(this.effectiveRating(i) ?? r.rating);
      }
    }
    /*
     * Neighbours search the whitened space, which the line does not use.
     *
     * Whitening is fitted from the features alone - it is not the taste
     * weighting, which does depend on the model and would make this circular.
     */
    /*
     * Fit twice, and let the cross-validation decide whether the names helped.
     *
     * This is not a formality. A dozen name components added to sixty-odd
     * audio features are a dozen more chances to fit noise, and measured
     * against ratings that owed nothing to the names, they cost 0.20 of
     * R-squared at sixty ratings - and about 0.01 at a hundred and fifty. So
     * the damage is real, it is concentrated exactly where a new user lives,
     * and it disappears on its own as the ratings pile up.
     *
     * Guessing a threshold for that would be inventing a number. The fit
     * already measures itself honestly, out of fold, so the cheap correct
     * thing is to run it both ways and keep whichever actually predicts
     * better. When the names carry nothing the audio model wins and nothing is
     * lost; when they carry something - and in these archives they usually do
     * - the difference is large enough to see.
     */
    const options = { rows, ratings, categoryOf: (row: number) => this.categoryOf(row) };
    const plain = fitTaste(this.flat, FEATURE_COUNT, {
      ...options,
      neighbourData: this.whitener
        ? whitenAll(this.flat, this.voices.length, FEATURE_COUNT, this.whitener)
        : undefined,
    });
    const named = this.semantic && this.semanticDim > FEATURE_COUNT
      ? fitTaste(this.semantic, this.semanticDim, {
        ...options,
        neighbourData: this.semanticNeighbour ?? undefined,
      })
      : null;

    this.nameGain = named && plain ? named.r2 - plain.r2 : 0;
    this.tasteUsesNames = !!named && (!plain || named.r2 > plain.r2);
    this.tasteModel = this.tasteUsesNames ? named : plain;
    this.fittedAt = this.ratings.size;
    this.ratingsSinceFit = 0;
    this.predicted = null;
    this.predictedDone = null;
    return this.tasteModel;
  }

  /** Refit from the current ratings and rebuild everything that depends on it. */
  async retrain(): Promise<void> {
    this.setBusy('learning from your ratings');
    await new Promise((r) => setTimeout(r, 0));
    try {
      this.refitTasteModel();
      this.applyWhitening();
    } finally {
      this.setBusy(null);
    }
  }

  /** Change how much names count, and rebuild everything that used them. */
  async setNameWeight(v: number): Promise<void> {
    const next = Math.max(0, Math.min(2, v));
    if (Math.abs(next - this.nameWeight) < 1e-6) return;
    this.nameWeight = next;
    if (!this.flat) {
      this.emit();
      return;
    }
    // Everything derived, not just the model: the map is laid out in this
    // space too, so moving the dial has to move the plot.
    await runTask('weighing the names', async (task) => {
      task.set(null, 'regrouping');
      await yieldToPaint();
      this.rebuildDerived();
      // The families are formed with the name hint, so the dial has to reform
      // them, not only refit the model.
      if (this.graph) this.applyThreshold(this.threshold, this.mergeThreshold, false);
    });
    this.emit();
  }

  setTasteStrength(v: number): void {
    this.tasteStrength = Math.max(0, Math.min(1, v));
    this.applyWhitening();
    this.emit();
  }

  /**
   * The model's guess at how this voice would be rated, or null.
   *
   * Cached per voice, and computed only for the voices actually asked about.
   * The neighbour term is a scan over every rated voice - nothing for one
   * patch, a second or two for forty thousand - and the first version filled
   * the whole corpus on the first call. That was fine while only the map axis
   * and the sidebar asked, and became a two-second stall on opening the browse
   * tab as soon as a table with a "guess" column existed, because forty rows
   * were enough to trigger all forty thousand.
   *
   * An axis that needs every value still pays the same total; it just pays it
   * when something wants the values rather than when something wants one.
   */
  predictedRating(index: number): number | null {
    const model = this.tasteModel;
    if (!model || !this.flat || !this.analysis[index]) return null;
    if (!this.predicted || this.predicted.length !== this.voices.length) {
      this.predicted = new Float32Array(this.voices.length);
      this.predictedDone = new Uint8Array(this.voices.length);
    }
    if (!this.predictedDone![index]) {
      const data = this.tasteUsesNames && this.semantic ? this.semantic : this.flat;
      const dim = this.tasteUsesNames && this.semantic ? this.semanticDim : FEATURE_COUNT;
      this.predicted[index] = predictRating(model, data, dim, index, this.categoryOf(index));
      this.predictedDone![index] = 1;
    }
    const v = this.predicted[index];
    return Number.isFinite(v) ? v : null;
  }

  /** The matrix distances should be measured in. */
  get distanceSpace(): Float32Array | null {
    return this.whitened ?? this.flat;
  }

  // ------------------------------------------------------------ clustering

  /**
   * Find the near-duplicate pairs, in a worker.
   *
   * Tens of millions of distance computations, which on a large corpus is
   * minutes. On the main thread that froze the tab: the progress callbacks
   * fired but nothing repainted between them, so the app looked hung for the
   * entire run and there was no way to stop it. Aborting terminates the worker,
   * which is the only way to stop a synchronous loop that is already going.
   */
  async buildClusters(opts: {
    maxDistance?: number;
    blockSize?: number;
    onProgress?: (done: number, total: number, stage: string) => void;
    signal?: AbortSignal;
  } = {}): Promise<void> {
    if (!this.flat) throw new Error('run the analysis pass first');
    const space = this.distanceSpace;
    if (!space) throw new Error('run the analysis pass first');
    this.setBusy('finding near-duplicates');

    const own = new AbortController();
    const signal = opts.signal ?? own.signal;

    const worker = new Worker(new URL('../workers/nearDupe.worker.ts', import.meta.url), { type: 'module' });
    try {
      const graph = await runTask('finding near-duplicates', (task) => new Promise<NearDupeGraph>((resolve, reject) => {
        const stop = () => {
          worker.terminate();
          reject(new DOMException('cancelled', 'AbortError'));
        };
        if (signal.aborted) return stop();
        signal.addEventListener('abort', stop, { once: true });

        worker.onmessage = (ev: MessageEvent<DupeResponse>) => {
          const msg = ev.data;
          if (msg.type === 'progress') {
            // Stages do not take equal time, so the fraction is within the
            // stage and the label says which stage it is.
            task.stage(msg.stage);
            task.set(msg.total > 0 ? msg.done / msg.total : null);
            opts.onProgress?.(msg.done, msg.total, msg.stage);
          } else if (msg.type === 'done') resolve(msg.graph);
          else reject(new Error(msg.message));
        };
        worker.onerror = (e) => reject(new Error(e.message || 'the near-duplicate worker failed'));

        const request: DupeRequest = {
          type: 'dupe',
          // A copy: the main thread still needs its own distance space.
          data: Float32Array.from(space),
          n: this.voices.length,
          dim: FEATURE_COUNT,
          unpacked: this.voices.map((v) => v.unpacked),
          opts: { maxDistance: opts.maxDistance ?? 0.4, blockSize: opts.blockSize ?? 400 },
        };
        worker.postMessage(request, [request.data.buffer]);
      }), { cancel: () => own.abort() });
      this.graph = graph;
      await kvSet('nearDupeGraph', graph);
      this.applyThreshold(this.threshold, this.mergeThreshold, true);
    } finally {
      worker.terminate();
      this.setBusy(null);
    }
  }

  sweep(thresholds: number[]): SweepRow[] {
    return this.graph ? thresholdSweep(this.graph, thresholds) : [];
  }

  applyThreshold(threshold: number, mergeThreshold = this.mergeThreshold, persist = true): void {
    this.threshold = threshold;
    this.mergeThreshold = Math.min(mergeThreshold, threshold);
    const space = this.distanceSpace;
    if (!this.graph || !space) return;
    /*
     * Families get the name hint. Merges never do.
     *
     * The two thresholds mean different things and only one of them can afford
     * to listen to a name. A merge says "these are the same patch, keep one" -
     * and two unrelated patches both called BASS 1 are not the same patch, so
     * anything that lets a name close that gap is a bug that quietly deletes
     * somebody's sound. A family says "these are alike, worth comparing", and
     * that is a judgement about perception, which is the one thing a name is
     * direct evidence of and the feature vector only ever approximates.
     *
     * So the graph stays audio-only, the merge level reads it raw, and the
     * family level shrinks an edge by up to NAME_PULL when two voices were
     * given clearly the same words by a person - clearly, because the
     * agreement floor in nameSpace.ts throws away the weak overlaps that are
     * the ones producing nonsense. It can only move pairs the audio already
     * nominated, and on this corpus ninety-three percent of pairs share no
     * word at all, so it is a nudge to a small minority rather than a smear.
     *
     * Measured over nine thousand of these voices: fifteen hundred pairs
     * brought in, two hundred and fifty more voices in a family, and the
     * largest family growing from 107 to 142 - which is the cost, and is why
     * the dial exists.
     */
    const vectors = this.nameSpace?.vectors;
    const closeness = vectors && this.nameWeight > 0 ? nameCloseness(vectors) : undefined;
    this.clusters = clusterAtThreshold(this.graph, this.threshold, closeness, NAME_PULL * this.nameWeight);
    this.representatives = chooseRepresentatives(this.clusters.clusters, space, FEATURE_COUNT);
    this.representativeSet = null;
    this.mergeClusters = clusterAtThreshold(this.graph, this.mergeThreshold);
    this.mergeRepresentatives = chooseRepresentatives(this.mergeClusters.clusters, space, FEATURE_COUNT);
    if (persist) {
      void kvSet('threshold', this.threshold);
      void kvSet('mergeThreshold', this.mergeThreshold);
    }
    this.emit();
  }

  // A voice added since the last clustering run has no entry in these tables,
  // so every lookup guards its index rather than assuming they are in step.

  /** Every voice in the same face-off family. */
  clusterMembers(index: number): number[] {
    if (!this.clusters || index >= this.clusters.labels.length) return [index];
    const id = this.clusters.labels[index];
    return id >= 0 ? this.clusters.clusters[id] : [index];
  }

  /**
   * Whether anything in this voice's family has been rated.
   *
   * A judgement about one member is a judgement about the family: they are
   * "similar but audibly different" by construction, so once you have scored
   * one you know roughly what the rest are worth. The interesting question is
   * always the family nobody has touched.
   *
   * Not the same as "is this voice rated". A family can be rated through a
   * member you found on the map while its chosen representative - the one the
   * queue would show you - is still blank.
   */
  familyHasRating(index: number): boolean {
    for (const m of this.clusterMembers(index)) {
      const v = this.voices[m];
      if (v && this.ratings.has(v.id)) return true;
    }
    return false;
  }

  /** Every voice treated as identical to this one. */
  mergedMembers(index: number): number[] {
    if (!this.mergeClusters || index >= this.mergeClusters.labels.length) return [index];
    const id = this.mergeClusters.labels[index];
    return id >= 0 ? this.mergeClusters.clusters[id] : [index];
  }

  /** The voice that stands in for `index` once near-identical copies are merged. */
  mergeRepresentativeOf(index: number): number {
    if (!this.mergeClusters || index >= this.mergeClusters.labels.length) return index;
    const id = this.mergeClusters.labels[index];
    return id >= 0 ? this.mergeRepresentatives[id] : index;
  }

  /**
   * Add a voice that was made here rather than imported - currently the output
   * of the map's interpolation mode.
   *
   * It arrives pinned and flagged as user-supplied, because the only reason to
   * keep one is that you want it in the final 128. It has no features until the
   * next analysis pass, which the corpus screen will offer.
   */
  async addSynthesised(unpacked: Uint8Array, name: string, note: string): Promise<number | null> {
    const clean = Uint8Array.from(unpacked);
    setVoiceName(clean, name);
    const packed = packVoice(clean);
    const key = packedKeyOf(packed);
    const existing = this.voices.findIndex((v) => packedKeyOf(v.packed) === key);
    if (existing >= 0) {
      // The blend landed exactly on a patch that is already here.
      if (!this.voices[existing].pinned) await this.togglePin(existing);
      return existing;
    }
    await addVoices([{
      packedKey: key,
      packed,
      unpacked: clean,
      name: voiceName(clean),
      sources: [{ file: note, bank: 'interpolated', slot: 0, name: voiceName(clean), container: 'raw', checksumOk: null }],
      pinned: true,
      clampedBytes: 0,
      userSupplied: true,
    }]);
    const rows = await getAllVoices();
    this.voices = rows.map(toLoaded);
    this.reindex();
    const analysis: Array<Analysis | null> = new Array(this.voices.length).fill(null);
    for (let i = 0; i < this.voices.length; i++) {
      const prev = this.analysis[i];
      if (prev && this.voices[i]) analysis[i] = prev;
    }
    this.analysis = analysis;
    this.emit();
    return this.voices.findIndex((v) => packedKeyOf(v.packed) === key);
  }

  isMergeRepresentative(index: number): boolean {
    return this.mergeRepresentativeOf(index) === index;
  }

  /**
   * Whether this voice is the one chosen to stand for its whole family.
   *
   * The looser of the two groupings: a family is "similar but audibly
   * different", so standing for one is a stronger claim than standing for a
   * set of near-identical copies. Backed by a set rather than a scan, because
   * the map asks this once per voice on every layout.
   */
  isFamilyRepresentative(index: number): boolean {
    if (!this.representativeSet || this.representativeSet.size !== this.representatives.length) {
      this.representativeSet = new Set(this.representatives);
    }
    return this.representativeSet.has(index);
  }

  private representativeSet: Set<number> | null = null;

  /**
   * The distinct sounds inside a face-off family: one per merge cluster, so
   * every pair the user is asked to compare is actually audibly different.
   */
  familyContenders(index: number): number[] {
    const members = this.clusterMembers(index);
    const seen = new Set<number>();
    const out: number[] = [];
    for (const m of members) {
      const rep = this.mergeRepresentativeOf(m);
      if (seen.has(rep)) continue;
      seen.add(rep);
      out.push(rep);
    }
    return out;
  }

  /** The 2D map coordinates used for coverage ordering: LDA if it worked, else PCA. */
  get mapProjection(): Float32Array | null {
    return this.ldaProjection ?? this.projection;
  }

  /**
   * Reorder so that each next voice is the one furthest from everything already
   * covered. Rating in this order spreads attention across the whole space
   * instead of grinding through the electric piano mass first.
   */
  async coverageOrder(indices: number[], onSlice?: SliceCallback): Promise<number[]> {
    let sliceStart = performance.now();
    const proj = this.mapProjection;
    if (!proj || indices.length < 3) return indices.slice();
    const px = (i: number) => proj[i * 2];
    const py = (i: number) => proj[i * 2 + 1];

    let cx = 0;
    let cy = 0;
    for (const i of indices) {
      cx += px(i);
      cy += py(i);
    }
    cx /= indices.length;
    cy /= indices.length;

    const remaining = indices.slice();
    let seedAt = 0;
    let seedD = Infinity;
    for (let k = 0; k < remaining.length; k++) {
      const dx = px(remaining[k]) - cx;
      const dy = py(remaining[k]) - cy;
      const d = dx * dx + dy * dy;
      if (d < seedD) {
        seedD = d;
        seedAt = k;
      }
    }

    const order: number[] = [remaining[seedAt]];
    remaining.splice(seedAt, 1);
    const minDist = remaining.map((i) => {
      const dx = px(i) - px(order[0]);
      const dy = py(i) - py(order[0]);
      return dx * dx + dy * dy;
    });

    while (remaining.length) {
      let best = 0;
      for (let k = 1; k < remaining.length; k++) if (minDist[k] > minDist[best]) best = k;
      const chosen = remaining[best];
      order.push(chosen);
      remaining.splice(best, 1);
      minDist.splice(best, 1);
      for (let k = 0; k < remaining.length; k++) {
        const dx = px(remaining[k]) - px(chosen);
        const dy = py(remaining[k]) - py(chosen);
        const d = dx * dx + dy * dy;
        if (d < minDist[k]) minDist[k] = d;
      }

      // Hand the thread back every so often.
      //
      // This is quadratic - every pick scans everything still unpicked - so on
      // a corpus of any size it is seconds of solid work. Run to completion it
      // freezes the tab: the progress bar is set, one frame paints, and then
      // nothing moves until it is done, which is indistinguishable from a
      // crash and is exactly what a progress bar is supposed to prevent.
      //
      // Sliced by elapsed time rather than by a count of picks, because the
      // cost of a pick falls as the remaining set shrinks: a fixed batch size
      // would yield far too often at the end and not nearly enough at the
      // start.
      if (onSlice && performance.now() - sliceStart > SLICE_MS) {
        await onSlice(order.length, indices.length);
        sliceStart = performance.now();
      }
    }
    return order;
  }

  /**
   * Work out what the model expects for each of these, a slice at a time.
   *
   * Predictions are cached per voice, so this is really about filling the
   * cache without blocking: the neighbour term scans every rated voice, and
   * doing forty thousand of those in one go costs as much as the coverage
   * ordering does.
   */
  async fillPredictions(indices: number[], onSlice?: SliceCallback): Promise<void> {
    let sliceStart = performance.now();
    for (let k = 0; k < indices.length; k++) {
      this.predictedRating(indices[k]);
      if (onSlice && performance.now() - sliceStart > SLICE_MS) {
        await onSlice(k, indices.length);
        sliceStart = performance.now();
      }
    }
  }

  // --------------------------------------------------------------- ratings

  async rate(index: number, rating: number, pass: RatingRecord['pass'] = 'round1'): Promise<void> {
    const v = this.voices[index];
    if (!v) return;
    const rec: RatingRecord = { voiceId: v.id, rating, at: Date.now(), pass };
    this.ratings.set(v.id, rec);
    this.emit();
    await putRating(rec);
    this.ratingsSinceFit++;
    this.maybeRefit();
  }

  /** How many ratings the model was last fitted on, and how many since. */
  private fittedAt = 0;
  private ratingsSinceFit = 0;
  private refitting = false;

  /**
   * Refit once enough has changed to be worth it.
   *
   * The model was fitted when the corpus was analysed and then never again
   * unless you pressed the button, so everything downstream of it drifted
   * steadily out of date as you rated - the predicted column, the axis you can
   * plot against, and the rating order that claims to put the best guesses
   * first. The one screen where you generate the evidence was the screen where
   * the model ignored it.
   *
   * Proportional rather than fixed, because the cost and the value move in
   * opposite directions. Early on twenty ratings is most of what is known and
   * the fit is instant; at four thousand it is noise, and the fit is a
   * neighbour scan over every rated pair. A quarter more than last time keeps
   * it frequent while it is cheap and rare once it is not, with a floor so the
   * first few dozen ratings still land.
   */
  private maybeRefit(): void {
    if (this.refitting || !this.flat) return;
    /*
     * Judgements since the last fit, not the size of the set.
     *
     * Changing your mind about a patch you already rated teaches the model
     * exactly as much as rating a new one - more, sometimes, since you went
     * back for it - and counting the set instead meant a session spent
     * revising never refitted at all.
     */
    if (this.ratingsSinceFit < Math.max(REFIT_FLOOR, Math.round(this.fittedAt * REFIT_FRACTION))) return;
    this.refitting = true;
    void runTask('learning from your ratings', async (task) => {
      task.set(null, `${fmtCount(this.ratings.size)} ratings`);
      await yieldToPaint();
      this.refitTasteModel();
      this.applyWhitening();
      this.emit();
    }).finally(() => {
      this.refitting = false;
    });
  }

  // ------------------------------------------------------------- ranking

  /**
   * Pairwise ranking inside a star band.
   *
   * Five stars saturate. Rate a few thousand patches and the top band holds
   * several hundred, which is both more than a bank can take and completely
   * unordered - the star says "I would keep this" and nothing about which of
   * two keepers you would rather have. No amount of rating fixes that, because
   * the scale has run out of room at exactly the point where the decision gets
   * hard.
   *
   * So the top band is ordered by comparison instead. Elo, because it wants
   * pairs rather than a total ordering, converges without ever showing every
   * pair (which at three hundred patches would be forty-five thousand), and
   * handles the fact that your judgement is noisy and occasionally cyclic.
   *
   * Deliberately a *sub*-rating. The score moves the patch within its star and
   * can never push it out of it, so a five that loses every comparison still
   * outranks every four. The stars are your judgement about quality; this is
   * only your judgement about order, and it should not be able to overrule the
   * first one.
   */
  rankings = new Map<number, Standing>();

  rankOf(index: number): Standing {
    const v = this.voices[index];
    return (v && this.rankings.get(v.id)) ?? newStanding();
  }

  /**
   * The rating a patch is actually worth, stars plus its standing.
   *
   * The offset is capped at 0.45 of a star, so the bands can never overlap:
   * ordering within a band is the only thing this is allowed to change.
   */
  effectiveRating(index: number): number | null {
    const stars = this.ratingOf(index);
    if (stars === null) return null;
    return stars + ratingOffset(this.rankOf(index));
  }

  /** Record one comparison, and settle both scores. */
  async recordWin(winner: number, loser: number): Promise<void> {
    const a = this.voices[winner];
    const b = this.voices[loser];
    if (!a || !b || a.id === b.id) return;

    const [won, lost] = applyResult(this.rankOf(winner), this.rankOf(loser));
    this.rankings.set(a.id, won);
    this.rankings.set(b.id, lost);
    this.emit();
    await this.saveRankings();
  }

  /** Forget one patch's standing, for when a comparison was a mis-click. */
  async clearRank(index: number): Promise<void> {
    const v = this.voices[index];
    if (!v) return;
    this.rankings.delete(v.id);
    this.emit();
    await this.saveRankings();
  }

  async resetRankings(): Promise<void> {
    this.rankings.clear();
    this.emit();
    await this.saveRankings();
  }

  private async saveRankings(): Promise<void> {
    await kvSet('rankings', [...this.rankings].map(([id, r]) => [id, r.score, r.games]));
  }

  /**
   * How many patches share the top rating anyone has given.
   *
   * Two is enough to have something to compare, and is also exactly when the
   * star scale has stopped telling those two apart.
   */
  rankableCount(): number {
    let top = 0;
    const counts = new Map<number, number>();
    for (const r of this.ratings.values()) {
      counts.set(r.rating, (counts.get(r.rating) ?? 0) + 1);
      if (r.rating > top) top = r.rating;
    }
    return counts.get(top) ?? 0;
  }

  /**
   * Everything in one star band, best first.
   *
   * The band is a rating, not a range: comparing a five against a four is a
   * question you have already answered with the stars.
   */
  rankedBand(stars: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.voices.length; i++) {
      if (this.ratingOf(i) === stars) out.push(i);
    }
    out.sort((x, y) => this.rankOf(y).score - this.rankOf(x).score);
    return out;
  }

  /** Remove a rating, so a mis-key can be undone without leaving the map. */
  async clearRating(index: number): Promise<void> {
    const v = this.voices[index];
    if (!v) return;
    this.ratings.delete(v.id);
    this.emit();
    await deleteRating(v.id);
  }

  async setCategoryOverride(index: number, category: Category | null): Promise<void> {
    this.predicted = null;
    this.predictedDone = null;
    const v = this.voices[index];
    if (!v) return;
    if (category) this.categoryOverrides.set(v.id, category);
    else this.categoryOverrides.delete(v.id);
    this.emit();
    await kvSet('categoryOverrides', [...this.categoryOverrides]);
  }

  async togglePin(index: number): Promise<void> {
    const v = this.voices[index];
    if (!v) return;
    v.pinned = !v.pinned;
    this.emit();
    await setPinned(v.id, v.pinned);
  }

  async setFaceoffExtras(clusterId: number, indices: number[]): Promise<void> {
    if (indices.length) this.faceoffExtras.set(clusterId, indices);
    else this.faceoffExtras.delete(clusterId);
    this.emit();
    await kvSet('faceoffExtras', [...this.faceoffExtras]);
  }

  // ------------------------------------------------------ export and backup

  /**
   * Every unique voice, as back-to-back 32-voice bulk dumps in one file.
   *
   * This is the deduplicated corpus in the format everything else in the DX7
   * world reads, so it is both a usable artefact and the thing to keep if the
   * browser's storage is ever lost. The final bank is padded with init voices,
   * since a bulk dump is always exactly 32.
   */
  exportDedupedSyx(): { bytes: Uint8Array; banks: number; voices: number } {
    const patches = this.voices.map((v) => v.unpacked);
    const bankCount = Math.max(1, Math.ceil(patches.length / 32));
    const out = new Uint8Array(bankCount * BANK_FILE_SIZE);
    for (let b = 0; b < bankCount; b++) {
      const slice: Uint8Array[] = [];
      for (let s = 0; s < 32; s++) {
        const p = patches[b * 32 + s];
        if (p) {
          slice.push(p);
        } else {
          const pad = Uint8Array.from(INIT_VOICE_PARAMS);
          setVoiceName(pad, '----------');
          slice.push(pad);
        }
      }
      out.set(buildBank(slice), b * BANK_FILE_SIZE);
    }
    return { bytes: out, banks: bankCount, voices: patches.length };
  }

  /**
   * Ratings, pins, category overrides and face-off results, keyed by the
   * packed-voice hash rather than by row id, so a backup still applies after
   * the corpus has been rebuilt from the source files.
   */
  exportBackup(): string {
    const ratings: Array<[string, number, number, string]> = [];
    const overrides: Array<[string, string]> = [];
    const pinned: string[] = [];
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      const key = packedKeyOf(v.packed);
      const r = this.ratings.get(v.id);
      if (r) ratings.push([key, r.rating, r.at, r.pass]);
      const o = this.categoryOverrides.get(v.id);
      if (o) overrides.push([key, o]);
      if (v.pinned) pinned.push(key);
    }
    const ranks: Array<[string, number, number]> = [];
    for (let i = 0; i < this.voices.length; i++) {
      const r = this.rankings.get(this.voices[i].id);
      if (r) ranks.push([packedKeyOf(this.voices[i].packed), Math.round(r.score * 100) / 100, r.games]);
    }
    const faceoff: Array<[string, string[]]> = [];
    for (const [clusterId, indices] of this.faceoffExtras) {
      const rep = this.representatives[clusterId];
      if (rep === undefined || !this.voices[rep]) continue;
      faceoff.push([
        packedKeyOf(this.voices[rep].packed),
        indices.filter((i) => this.voices[i]).map((i) => packedKeyOf(this.voices[i].packed)),
      ]);
    }
    return JSON.stringify({
      format: 'dx7curation-backup',
      version: 1,
      savedAt: new Date().toISOString(),
      voiceCount: this.voices.length,
      threshold: this.threshold,
      mergeThreshold: this.mergeThreshold,
      ratings,
      overrides,
      pinned,
      faceoff,
      ranks,
    });
  }

  async importBackup(json: string): Promise<{ ratings: number; overrides: number; pinned: number; missing: number }> {
    const data = JSON.parse(json) as {
      format?: string;
      ratings?: Array<[string, number, number, string]>;
      overrides?: Array<[string, string]>;
      pinned?: string[];
      faceoff?: Array<[string, string[]]>;
      ranks?: Array<[string, number, number]>;
      threshold?: number;
      mergeThreshold?: number;
    };
    if (data.format !== 'dx7curation-backup') throw new Error('that file is not a curation backup');

    const byKey = new Map<string, number>();
    for (let i = 0; i < this.voices.length; i++) byKey.set(packedKeyOf(this.voices[i].packed), i);

    let missing = 0;
    let applied = 0;
    for (const [key, rating, at, pass] of data.ratings ?? []) {
      const ix = byKey.get(key);
      if (ix === undefined) {
        missing++;
        continue;
      }
      const rec: RatingRecord = { voiceId: this.voices[ix].id, rating, at, pass: pass as RatingRecord['pass'] };
      this.ratings.set(rec.voiceId, rec);
      await putRating(rec);
      applied++;
    }

    let overrides = 0;
    for (const [key, category] of data.overrides ?? []) {
      const ix = byKey.get(key);
      if (ix === undefined) {
        missing++;
        continue;
      }
      this.categoryOverrides.set(this.voices[ix].id, category as Category);
      overrides++;
    }
    await kvSet('categoryOverrides', [...this.categoryOverrides]);

    let pinned = 0;
    for (const key of data.pinned ?? []) {
      const ix = byKey.get(key);
      if (ix === undefined) {
        missing++;
        continue;
      }
      this.voices[ix].pinned = true;
      await setPinned(this.voices[ix].id, true);
      pinned++;
    }

    for (const [key, score, games] of data.ranks ?? []) {
      const ix = byKey.get(key);
      if (ix === undefined) continue;
      this.rankings.set(this.voices[ix].id, { score, games });
    }
    if (data.ranks?.length) await this.saveRankings();

    if (typeof data.threshold === 'number') {
      this.applyThreshold(data.threshold, data.mergeThreshold ?? this.mergeThreshold);
    }

    // Face-off results are keyed by cluster, which only exists once clustering
    // has run with the restored thresholds.
    if (this.clusters) {
      for (const [repKey, memberKeys] of data.faceoff ?? []) {
        const repIx = byKey.get(repKey);
        if (repIx === undefined) continue;
        const clusterId = this.clusters.labels[repIx];
        if (clusterId < 0) continue;
        const indices = memberKeys.map((k) => byKey.get(k)).filter((i): i is number => i !== undefined);
        if (indices.length) this.faceoffExtras.set(clusterId, indices);
      }
      await kvSet('faceoffExtras', [...this.faceoffExtras]);
    }

    this.emit();
    return { ratings: applied, overrides, pinned, missing };
  }

  // ------------------------------------------------------- whole sessions

  /**
   * The entire session as one file: the patches themselves, plus every
   * judgement made about them.
   *
   * The smaller backup above carries only judgements, keyed by patch content -
   * which is exactly right for reapplying your ratings to a corpus you still
   * have, and useless for moving to another machine, where there is nothing for
   * those keys to match. That distinction was invisible: the button said
   * "session backup", the file restored silently into nothing, and the only
   * clue was a count of entries that referred to patches that were not there.
   *
   * Features are deliberately not included. They are by far the largest part of
   * the session - tens of megabytes of vectors, envelopes and spectra - and
   * they are a pure function of the patch bytes, so re-rendering them costs
   * minutes of CPU rather than a download. Everything that cannot be recomputed
   * is here.
   */
  exportSession(): string {
    const voices = this.voices.map((v) => ({
      p: bytesToBase64(v.packed),
      n: v.name,
      s: v.sources,
      pin: v.pinned || undefined,
      us: v.userSupplied || undefined,
    }));
    return JSON.stringify({
      format: 'dx7curation-session',
      version: 1,
      savedAt: new Date().toISOString(),
      threshold: this.threshold,
      mergeThreshold: this.mergeThreshold,
      voices,
      judgements: JSON.parse(this.exportBackup()) as unknown,
    });
  }

  /** True when `json` is a whole session rather than judgements alone. */
  static isSession(json: string): boolean {
    try {
      return (JSON.parse(json) as { format?: string }).format === 'dx7curation-session';
    } catch {
      return false;
    }
  }

  /**
   * Replace everything with the contents of a session file.
   *
   * Destructive by nature - a session is a whole state, not a set of edits -
   * so the caller is expected to have asked first.
   */
  async importSession(json: string): Promise<{ voices: number }> {
    const data = JSON.parse(json) as {
      format?: string;
      voices?: Array<{ p: string; n: string; s: VoiceSource[]; pin?: boolean; us?: boolean }>;
      judgements?: unknown;
    };
    if (data.format !== 'dx7curation-session') throw new Error('that file is not a full session');
    const rows = data.voices ?? [];

    await runTask('restoring the session', async (task) => {
      /*
       * Everything that can fail happens before anything is destroyed.
       *
       * This used to clear the corpus first and unpack afterwards, which meant
       * any failure in between - a truncated file, a voice that will not
       * unpack, the tab running out of memory on a hundred-megabyte session -
       * left you with no corpus and no error worth reading. It looked like the
       * restore had done nothing. It had done the worst possible thing.
       *
       * So: unpack the whole file into records first, and only clear once
       * there is something to put back.
       */
      task.stage('unpacking');
      const records: Array<Omit<VoiceRecord, 'id'>> = [];
      for (let i = 0; i < rows.length; i++) {
        const packed = base64ToBytes(rows[i].p);
        records.push({
          packedKey: packedKeyOf(packed),
          packed,
          unpacked: unpackVoice(packed),
          name: rows[i].n,
          sources: rows[i].s ?? [],
          pinned: !!rows[i].pin,
          clampedBytes: 0,
          userSupplied: !!rows[i].us,
        });
        if ((i & 1023) === 0) {
          task.set(rows.length ? (i / rows.length) * 0.4 : null, `${fmtCount(i)} of ${fmtCount(rows.length)}`);
          await yieldToPaint();
        }
      }

      if (records.length === 0) throw new Error('that session file has no patches in it');

      task.stage('clearing the old corpus');
      await this.reset();

      task.stage('writing to the database');
      await addVoices(records, (done, total) => task.set(0.4 + (done / total) * 0.6, `${fmtCount(done)} of ${fmtCount(total)}`));
    });

    // Read it back the normal way, so a restored session and a reloaded one
    // arrive in exactly the same state.
    this.voices = [];
    this.ratings.clear();
    await this.load();
    if (data.judgements) await this.importBackup(JSON.stringify(data.judgements));
    this.emit();
    return { voices: rows.length };
  }

  /** Clear every rating and face-off result, keeping the corpus and features. */
  async resetRatings(): Promise<void> {
    this.ratings.clear();
    this.faceoffExtras.clear();
    this.rankings.clear();
    this.emit();
    await clearRatings();
    await kvSet('faceoffExtras', []);
    await kvSet('rankings', []);
  }

  async reset(): Promise<void> {
    await clearAll();
    this.voices = [];
    this.indexById.clear();
    this.analysis = [];
    this.standardizer = null;
    this.flat = null;
    this.graph = null;
    this.clusters = null;
    this.representatives = [];
    this.representativeSet = null;
    this.ratings.clear();
    this.categoryOverrides.clear();
    this.faceoffExtras.clear();
    this.projection = null;
    this.ldaProjection = null;
    this.whitened = null;
    this.whitener = null;
    this.tasteModel = null;
    this.predicted = null;
    this.predictedDone = null;
    this.mergeClusters = null;
    this.mergeRepresentatives = [];
    this.lastIngest = null;
    this.emit();
  }
}

/** Reject a stored feature row whose vector predates the current feature set. */
function toAnalysis(f: FeatureRecord): Analysis | null {
  if (!f.vector || f.vector.length !== FEATURE_COUNT) return null;
  // Measured by a version of the analysis that no longer exists: the numbers
  // are not comparable with anything measured since, so they count as stale
  // and the app offers to run the pass again.
  if ((f.analysisVersion ?? 1) !== ANALYSIS_VERSION) return null;
  return {
    acoustic: f.acoustic as Analysis['acoustic'],
    structural: f.structural as StructuralFeatures,
    vector: f.vector,
    category: f.category as Category,
    subcategory: f.subcategory ?? '',
    categoryConfidence: f.categoryConfidence,
    silent: f.silent,
  };
}

function toLoaded(v: VoiceRecord): LoadedVoice {
  return {
    id: v.id,
    name: v.name,
    unpacked: v.unpacked,
    packed: v.packed,
    sources: v.sources,
    pinned: v.pinned,
    userSupplied: v.userSupplied,
    clampedBytes: v.clampedBytes,
  };
}

export const store = new Store();
