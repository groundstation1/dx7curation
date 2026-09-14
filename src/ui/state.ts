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
import { ANALYSIS_VERSION, fitStandardizer, standardize, FEATURE_COUNT, type Standardizer } from '../features/vector.ts';
import type { DupeRequest, DupeResponse } from '../workers/nearDupe.worker.ts';
import type { EmbedRequest, EmbedResponse } from '../workers/embed.worker.ts';
import { clusterAtThreshold, chooseRepresentatives, thresholdSweep, type NearDupeGraph, type NearDupeClusters, type SweepRow } from '../cluster/nearDupe.ts';
import { pca } from '../cluster/pca.ts';
import { fitWhitener, whitenAll, redundancyRatio, redundancyWeights, type Whitener } from '../cluster/whiten.ts';
import { fitTaste, predictRating, tasteWeights, type TasteModel } from '../cluster/taste.ts';
import { lda } from '../cluster/lda.ts';
import { CATEGORIES, CATEGORIZER_VERSION, categorize, type Category } from '../cluster/category.ts';
import type { AcousticFeatures } from '../features/acoustic.ts';
import type { StructuralFeatures } from '../features/structural.ts';
import { analyzeAll, type PoolProgress } from '../workers/pool.ts';
import { isZip, extractZip } from '../util/zip.ts';
import { runTask, type TaskHandle } from './task.ts';
import {
  SESSION_FORMAT, SESSION_VERSION, f32ToBase64, i32ToBase64, base64ToF32, base64ToI32,
  featuresUsable, graphUsable, isSessionJson,
  type SessionFile, type SessionFeatures,
} from './session.ts';
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

/**
 * Whether something inside an archive or a folder is worth opening.
 *
 * By name where the name says so, and otherwise by size, because a great many
 * of these files are called things like `BANK12` with no extension at all: a
 * 32-voice bulk dump is 4104 bytes, a single voice is 163, and a headerless
 * bank is a whole number of 4096-byte pages. Anything else is somebody's
 * readme, cover scan or manual, and opening it would only produce an error
 * about a file nobody asked to import.
 *
 * Shared by the zip reader and the folder walk so that dropping a folder and
 * dropping a zip of that folder do the same thing - which is the only
 * behaviour anybody would predict.
 */
export function looksLikeVoiceFile(name: string, size: number): boolean {
  if (name.endsWith('/') || size <= 0) return false;
  return VOICE_EXTENSIONS.test(name) || size === 4104 || size === 163 || size % 4096 === 0;
}

export class Store {
  voices: LoadedVoice[] = [];
  indexById = new Map<number, number>();
  analysis: Array<Analysis | null> = [];
  standardizer: Standardizer | null = null;
  /** Standardised vectors, n * FEATURE_COUNT, row-major. */
  flat: Float32Array | null = null;
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
  graph: NearDupeGraph | null = null;
  /*
   * The neighbourhood map: n * 2 coordinates, or null until it is asked for.
   *
   * The variation axes answer "which way does the corpus vary most", which is
   * a fact about the corpus rather than about any two patches in it, and it
   * shows: a family that near-duplicate detection groups perfectly can still
   * be smeared across the plot because some strong unrelated direction runs
   * through it. This is the other kind of map - laid out so that things close
   * in the feature space come out close on screen - and it is computed from
   * the same distances the families are built from, which is why it agrees
   * with them.
   *
   * Expensive enough to be explicit about (a few seconds, in a worker) and
   * small enough to keep (two floats a voice), so it is computed on request
   * and stored.
   */
  embedding: Float32Array | null = null;
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

        // Cheap to keep and slow to make, so it comes back with everything
        // else. Tied to the corpus size: add patches and it is stale.
        const savedEmbedding = await kvGet<{ n: number; coords: Float32Array }>('embedding');
        if (savedEmbedding && savedEmbedding.n === this.voices.length) {
          this.embedding = savedEmbedding.coords instanceof Float32Array
            ? savedEmbedding.coords
            : Float32Array.from(savedEmbedding.coords as ArrayLike<number>);
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
          looksLikeVoiceFile,
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

    /*
     * Three long steps, each of which reports.
     *
     * All three used to happen behind one bar that had already been set to
     * 100%, so an import into a large library sat at "writing to the database,
     * 0s left" for as long as a minute and looked hung. Two of them are not
     * even writes: reading thirty-nine thousand voices and thirty-five
     * thousand feature rows back out, through the unpaged `getAll` that the
     * startup path abandoned years ago for being one opaque await of several
     * seconds. Paged, they say where they are.
     */
    task.stage('writing to the database');
    task.set(0);
    opts.onProgress?.('writing to the database', files.length, files.length);
    const { added, merged } = await addVoices(pending, (done, total) => {
      task.set(total ? done / total : null, `${fmtCount(done)} of ${fmtCount(total)}`);
    });
    summary.added = added;
    summary.merged = merged;
    summary.skipped = [...skipTally].map(([reason, count]) => ({ reason, count }));

    task.stage('reading the corpus back');
    const rows = await getAllVoicesPaged((done, total) => {
      task.set(total ? done / total : null, `${fmtCount(done)} of ${fmtCount(total)}`);
    });
    this.voices = rows.map(toLoaded);
    this.reindex();
    const previous = this.analysis;
    this.analysis = new Array(this.voices.length).fill(null);
    // Keep analysis for voices that were already there.
    task.stage('matching up measurements');
    const featureRows = await getAllFeaturesPaged((done, total) => {
      task.set(total ? done / total : null, `${fmtCount(done)} of ${fmtCount(total)}`);
    });
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
    this.refitTasteModel();
    this.applyWhitening();

    // The map's variation axes are computed on a redundancy-weighted copy, so
    // that a family of near-duplicate features cannot claim a principal axis
    // just by being numerous.
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
    const l = lda(flat, n, FEATURE_COUNT, labels, CATEGORIES.length, 2);
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
    const neighbourData = this.whitener
      ? whitenAll(this.flat, this.voices.length, FEATURE_COUNT, this.whitener)
      : undefined;

    this.tasteModel = fitTaste(this.flat, FEATURE_COUNT, {
      rows,
      ratings,
      neighbourData,
      categoryOf: (row) => this.categoryOf(row),
    });
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
      this.predicted[index] = predictRating(model, this.flat, FEATURE_COUNT, index, this.categoryOf(index));
      this.predictedDone![index] = 1;
    }
    const v = this.predicted[index];
    return Number.isFinite(v) ? v : null;
  }

  /**
   * How far apart two voices are, in the space everything else measures in.
   *
   * The same numbers the near-duplicate thresholds are quoted against, so a
   * distance read here and a distance read there mean the same thing.
   */
  featureDistance(a: number, b: number): number {
    const space = this.distanceSpace;
    if (!space || a === b) return 0;
    let sum = 0;
    const ai = a * FEATURE_COUNT;
    const bi = b * FEATURE_COUNT;
    for (let d = 0; d < FEATURE_COUNT; d++) {
      const x = space[ai + d] - space[bi + d];
      sum += x * x;
    }
    return Math.sqrt(sum);
  }

  /**
   * Whether a voice is one you brought yourself.
   *
   * True if any copy of it arrived from outside a prepared collection, which
   * is the generous reading and the right one: a patch you uploaded is yours
   * however many bundled sets also happen to carry it. Every source written
   * before bundles existed has no tag, so an old library is entirely yours
   * without anything having to be migrated.
   */
  isMine(index: number): boolean {
    const sources = this.voices[index]?.sources;
    if (!sources || sources.length === 0) return true;
    return sources.some((src) => !src.bundle);
  }

  /** The names of every prepared collection represented in the corpus. */
  bundleNames(): string[] {
    const out = new Set<string>();
    for (const v of this.voices) {
      for (const src of v.sources) if (src.bundle) out.add(src.bundle);
    }
    return [...out].sort();
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
  /**
   * Lay the map out from neighbourhoods instead of from variance.
   *
   * Runs on `distanceSpace` - the same matrix the near-duplicate pass and the
   * families use - so the picture inherits whatever makes those feel right.
   * Started from the PCA projection, so the result keeps the global
   * arrangement people are already used to rather than arriving rotated at
   * random.
   */
  async buildEmbedding(opts: { signal?: AbortSignal } = {}): Promise<void> {
    const space = this.distanceSpace;
    if (!space || this.voices.length < 8) throw new Error('run the analysis pass first');
    const n = this.voices.length;

    const own = new AbortController();
    const signal = opts.signal ?? own.signal;
    const worker = new Worker(new URL('../workers/embed.worker.ts', import.meta.url), { type: 'module' });
    try {
      const coords = await runTask('laying out the neighbourhood map', (task) => new Promise<Float32Array>((resolve, reject) => {
        const stop = () => {
          worker.terminate();
          reject(new DOMException('cancelled', 'AbortError'));
        };
        if (signal.aborted) return stop();
        signal.addEventListener('abort', stop, { once: true });
        worker.onmessage = (ev: MessageEvent<EmbedResponse>) => {
          const msg = ev.data;
          if (msg.type === 'progress') task.set(msg.done / msg.total, msg.stage);
          else if (msg.type === 'done') resolve(msg.coords);
          else reject(new Error(msg.message));
        };
        worker.onerror = (e) => reject(new Error(e.message || 'the layout worker failed'));
        const data = Float32Array.from(space);
        const request: EmbedRequest = {
          type: 'embed',
          data,
          n,
          dim: FEATURE_COUNT,
          init: this.projection ? Float32Array.from(this.projection) : undefined,
        };
        worker.postMessage(request, [data.buffer]);
      }), { cancel: () => own.abort() });

      this.embedding = coords;
      await kvSet('embedding', { n, coords });
      this.emit();
    } finally {
      worker.terminate();
    }
  }

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
    this.clusters = clusterAtThreshold(this.graph, this.threshold);
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

  /**
   * Where a voice with exactly these parameters sits, or -1.
   *
   * The key excludes the ten-byte name field, which is what makes this the
   * right question to ask of a patch that arrived from somewhere else: two
   * files calling the same sound RHODES and E.PIANO are the same sound, and
   * the one you already rated is the one you want opened.
   */
  indexOfPacked(packed: Uint8Array): number {
    const key = packedKeyOf(packed);
    return this.voices.findIndex((v) => packedKeyOf(v.packed) === key);
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
  async addSynthesised(
    unpacked: Uint8Array, name: string, note: string,
    opts: { pinned?: boolean; bank?: string } = {},
  ): Promise<number | null> {
    const pin = opts.pinned ?? true;
    const clean = Uint8Array.from(unpacked);
    setVoiceName(clean, name);
    const packed = packVoice(clean);
    const key = packedKeyOf(packed);
    const existing = this.voices.findIndex((v) => packedKeyOf(v.packed) === key);
    if (existing >= 0) {
      // The blend landed exactly on a patch that is already here.
      if (pin && !this.voices[existing].pinned) await this.togglePin(existing);
      return existing;
    }
    await addVoices([{
      packedKey: key,
      packed,
      unpacked: clean,
      name: voiceName(clean),
      sources: [{ file: note, bank: opts.bank ?? 'interpolated', slot: 0, name: voiceName(clean), container: 'raw', checksumOk: null }],
      pinned: pin,
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

    /*
     * The measurements travel with the patches.
     *
     * They used to be left out, on the reasoning that they are a pure function
     * of the patch bytes and so cost a download rather than a recomputation.
     * The recomputation is eight minutes of rendering, a near-duplicate pass
     * and a layout, which is not a saving, it is the whole cost of opening the
     * app moved to the other end. Stamped with the version they were measured
     * under so a build that measures differently throws them away.
     */
    const features = this.exportFeatures();
    const embedding = this.embedding && this.embedding.length >= this.voices.length * 2
      ? { n: this.voices.length, coords: f32ToBase64(this.embedding) }
      : undefined;
    const graph = this.graph && this.graph.n === this.voices.length
      ? {
        n: this.graph.n,
        a: i32ToBase64(this.graph.a),
        b: i32ToBase64(this.graph.b),
        d: f32ToBase64(this.graph.d),
        featureScale: this.graph.featureScale,
        paramScale: this.graph.paramScale,
        featureWeight: this.graph.featureWeight,
        paramWeight: this.graph.paramWeight,
        blocks: this.graph.blocks,
        truncated: this.graph.truncated,
      }
      : undefined;

    const file: SessionFile = {
      format: SESSION_FORMAT,
      version: SESSION_VERSION,
      savedAt: new Date().toISOString(),
      threshold: this.threshold,
      mergeThreshold: this.mergeThreshold,
      voices,
      judgements: JSON.parse(this.exportBackup()) as unknown,
      features,
      graph,
      embedding,
    };
    return JSON.stringify(file);
  }

  /** Every voice's measurements, in voice order, or nothing if any is missing. */
  private exportFeatures(): SessionFeatures | undefined {
    const n = this.voices.length;
    if (n === 0) return undefined;
    const vectors: string[] = [];
    const categories: string[] = [];
    const subcategories: string[] = [];
    const confidence: number[] = [];
    const acoustic: unknown[] = [];
    const structural: unknown[] = [];
    const silent = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const a = this.analysis[i];
      // All or nothing: a half-measured corpus would have to be tracked
      // per voice on the way back in, and the pass that fills the gaps is the
      // same pass that would have measured all of them.
      if (!a) return undefined;
      vectors.push(f32ToBase64(a.vector));
      acoustic.push(a.acoustic);
      structural.push(a.structural);
      categories.push(a.category ?? '');
      subcategories.push(a.subcategory ?? '');
      confidence.push(a.categoryConfidence ?? 0);
      silent[i] = a.silent ? 1 : 0;
    }
    return {
      analysisVersion: ANALYSIS_VERSION,
      vectors, acoustic, structural, categories, subcategories, confidence,
      silent: bytesToBase64(silent),
    };
  }

  /** True when `json` is a whole session rather than judgements alone. */
  static isSession(json: string): boolean {
    return isSessionJson(json);
  }

  /**
   * Replace everything with the contents of a session file.
   *
   * Destructive by nature - a session is a whole state, not a set of edits -
   * so the caller is expected to have asked first.
   */
  async importSession(json: string, opts: { bundle?: string } = {}): Promise<{ voices: number }> {
    const data = JSON.parse(json) as SessionFile;
    if (data.format !== SESSION_FORMAT) throw new Error('that file is not a full session');
    // A shipped collection is tagged by the manifest that offered it, so an
    // ordinary session exported from the app can be published as one without
    // being edited first.
    if (opts.bundle) data.bundle = opts.bundle;
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
          /*
           * A bundled collection stamps its name on every source it brings.
           *
           * Only where there is none already, so a patch you also happened to
           * upload yourself keeps its own provenance and goes on counting as
           * yours. Nothing is stamped for an ordinary session, and an
           * unstamped source is what every file written before this looks
           * like - which is why absent means "mine".
           */
          sources: data.bundle
            ? (rows[i].s ?? []).map((src) => (src.bundle ? src : { ...src, bundle: data.bundle }))
            : rows[i].s ?? [],
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
      const written = await addVoices(records, (done, total) => task.set(0.4 + (done / total) * 0.6, `${fmtCount(done)} of ${fmtCount(total)}`));
      void written;

      /*
       * Measurements, if the file brought any that this build can believe.
       *
       * Written against the ids the database just assigned, which is why this
       * happens here rather than in `load` - the file knows voices by their
       * position in its own list and nothing else.
       */
      const stored = await getAllVoices();
      const byKey = new Map(stored.map((v) => [v.packedKey, v.id]));

      /*
       * The ratings are written here, not after the corpus is read back.
       *
       * They used to be applied in a second phase, once `load` had rebuilt
       * everything in memory - which left a window where the old corpus was
       * already gone and the new ratings had not landed. Anything that
       * interrupts the tab in that window (a browser suspending a background
       * page is how it was found) leaves patches with no ratings and no way
       * back. They are the one thing in this file nobody can reproduce, so
       * they go in as soon as there are ids to attach them to, inside the same
       * protected pass as the voices.
       *
       * Everything else the judgements carry - pins, overrides, ranks,
       * face-off results - is reapplied afterwards through the usual path,
       * which rewrites these harmlessly.
       */
      const judged = data.judgements as { ratings?: Array<[string, number, number, string]> } | undefined;
      if (judged?.ratings?.length) {
        task.stage('restoring ratings');
        for (const [key, rating, at, pass] of judged.ratings) {
          const id = byKey.get(key);
          if (id === undefined) continue;
          await putRating({ voiceId: id, rating, at, pass: pass as RatingRecord['pass'] });
        }
      }

      if (featuresUsable(data.features, rows.length)) {
        task.stage('restoring measurements');
        const silent = base64ToBytes(data.features.silent ?? '');
        const batch: FeatureRecord[] = [];
        for (let i = 0; i < rows.length; i++) {
          const id = byKey.get(records[i].packedKey);
          if (id === undefined) continue;
          batch.push({
            voiceId: id,
            analysisVersion: data.features.analysisVersion,
            acoustic: data.features.acoustic[i] ?? null,
            structural: data.features.structural[i] ?? null,
            vector: base64ToF32(data.features.vectors[i]),
            category: data.features.categories[i] ?? '',
            subcategory: data.features.subcategories[i] ?? '',
            categoryConfidence: data.features.confidence[i] ?? 0,
            silent: silent[i] === 1,
          });
          if ((i & 2047) === 0) {
            task.set(rows.length ? i / rows.length : null, `${fmtCount(i)} of ${fmtCount(rows.length)}`);
            await yieldToPaint();
          }
        }
        await putFeatures(batch);
      }

      // The near-duplicate graph, which is the other pass measured in minutes.
      if (graphUsable(data.graph, rows.length)) {
        await kvSet('nearDupeGraph', {
          n: data.graph.n,
          a: base64ToI32(data.graph.a),
          b: base64ToI32(data.graph.b),
          d: base64ToF32(data.graph.d),
          featureScale: data.graph.featureScale,
          paramScale: data.graph.paramScale,
          featureWeight: data.graph.featureWeight,
          paramWeight: data.graph.paramWeight,
          blocks: data.graph.blocks,
          truncated: data.graph.truncated,
        } satisfies NearDupeGraph);
      }
      if (data.embedding && data.embedding.n === rows.length) {
        await kvSet('embedding', { n: data.embedding.n, coords: base64ToF32(data.embedding.coords) });
      }
      if (typeof data.threshold === 'number') await kvSet('threshold', data.threshold);
      if (typeof data.mergeThreshold === 'number') await kvSet('mergeThreshold', data.mergeThreshold);
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
    this.embedding = null;
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
