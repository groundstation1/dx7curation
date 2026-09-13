/*
 * Sources: bring patches in, and let the app get them ready.
 *
 * This screen used to be a worklist. You dropped files, then pressed Analyse
 * and waited, then pressed Find near-duplicates and waited, then read a table
 * of nine distances and chose two of them - four decisions and about four
 * hundred words of explanation before anything was listenable. Every one of
 * those steps has a right answer nearly all of the time.
 *
 * So it runs itself. Dropping files starts the analysis, the analysis starts
 * the near-duplicate pass, and the thresholds take the defaults that have held
 * up across every corpus tried so far. All of it reports through the one
 * progress bar and all of it can be stopped. The sweep table that used to be
 * the point of the screen is still here, under the advanced switch, for when
 * you want to disagree with the defaults - which is a thing worth doing, just
 * not a thing worth requiring.
 */
import { clear, downloadBytes, el, fmtInt, pageHead, patchFile } from '../dom.ts';
import type { View, ViewContext } from '../app.ts';
import { adv, disclosure, isAdvanced } from '../advanced.ts';
import { getSetting, setSetting } from '../settings.ts';
import { gzip, readSessionBytes } from '../session.ts';
import { availableBundles, fetchBundle, type BundleEntry } from '../bundles.ts';
import { Store } from '../state.ts';
import { SIZE_BUCKETS } from '../../cluster/nearDupe.ts';
import { listenForSysex, listInputs, midiSupported, requestBulkDump, requestMidi, type MidiPort } from '../../midi/webmidi.ts';
import { parseSysexFile } from '../../sysex/parse.ts';
import { topTerms } from '../../cluster/taste.ts';
import { CATEGORY_LABELS, type Category } from '../../cluster/category.ts';
import { categoryColour } from '../colour.ts';
import { FEATURE_DEFS } from '../../features/vector.ts';
import { rankSources, sortSources, SOURCE_LEVELS, type SourceLevel, type SourceScore } from '../sourceRanking.ts';
import { ratingColour } from '../colour.ts';
import { activeTask, claimTaskDisplay, runTask, subscribeTasks } from '../task.ts';

const SWEEP_POINTS = [0.01, 0.02, 0.03, 0.05, 0.08, 0.12, 0.16, 0.22, 0.3];

/** How many sources the table shows before it stops. */
const SOURCE_ROWS = 24;

/** Where to get a lot of patches at once, for someone who has none. */

let ctx: ViewContext;
let container: HTMLElement;
let unsubscribe: (() => void) | null = null;
let analysisAbort: AbortController | null = null;
let dupeAbort: AbortController | null = null;
let embedAbort: AbortController | null = null;
/** Set while the chain is running, and cleared if any step is cancelled. */
let advancing = false;
let lastNote = '';
/**
 * A load started from the first screen owns it while it runs.
 *
 * The header bar is right for work you set going and then carry on around. It
 * is wrong for the one action on a screen with nothing else on it, where the
 * cards it would be happening behind are no longer choices.
 */
let splashBusy = false;
/**
 * Closed for now.
 *
 * The first screen is a choice, and a choice you cannot decline is a wall.
 * Someone who wants to look at the app before handing it anything can shut it;
 * everything it offers is on Sources anyway, which is what is underneath.
 */
let splashDismissed = false;
let splashBar: HTMLElement | null = null;
let splashUnsub: (() => void) | null = null;

/** Device read-back: which output to ask, and what has arrived so far. */
let deviceOutputs: MidiPort[] = [];
let deviceOutputId = '';
let deviceChannel = 1;
let listening: (() => void) | null = null;
let deviceLog: string[] = [];
let deviceBanks: Array<{ bytes: Uint8Array; from: string; voices: number; at: number }> = [];

function statBlock(k: string, v: string): HTMLElement {
  return el('div', { class: 'stat' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v));
}

// ------------------------------------------------------------------ intake

/**
 * The "your own files" half of the splash: a card that is itself the target.
 *
 * Shares the drop handling with the ordinary zone and none of its chrome - no
 * second border, no repeated sentence - and puts the button on the bottom edge
 * so the two cards end level.
 */
function dropCard(): HTMLElement {
  const card = el('div', { class: 'splash-card dropzone' });
  const inner = dropZone(true, card);
  inner.classList.remove('dropzone');
  inner.classList.add('drop-inner');
  /*
   * The act holds the button and nothing else, in both cards.
   *
   * It is the element with `margin-top: auto`, so whatever is inside it is
   * what sits on the bottom edge. The drop zone brings a pin toggle along with
   * the button, and while that rode inside the act this card's button sat a
   * row higher than the one beside it. Hoisted out, both acts contain one
   * button and the pair lines up.
   */
  const act = el('div', { class: 'splash-act' }, inner);
  card.append(
    el('h2', {}, 'Your own files'),
    el('p', {}, 'Drop .syx files, a folder or a zip.'),
    // Above the button, not below it: the button has to be the last thing in
    // both cards or it cannot sit on the same line as the one beside it.
    el('div', { class: 'splash-fine' }, 'Stays on this machine.'),
    act,
  );
  const pin = inner.querySelector('.field');
  if (pin) card.insertBefore(pin, act);
  return card;
}

function dropZone(big: boolean, host?: HTMLElement): HTMLElement {
  const input = el('input', {
    type: 'file',
    multiple: true,
    style: { display: 'none' },
    onchange: () => {
      const files = [...(input.files ?? [])];
      if (files.length) void ingest(files, pinToggle.checked);
      input.value = '';
    },
  });

  const pinToggle = el('input', { type: 'checkbox' }) as HTMLInputElement;

  /*
   * Pinning on import is how you say "these are mine, keep them" before you
   * have listened to anything. Hidden until asked for, since the common case
   * is dropping an archive you have never heard.
   *
   * Above the button on the first screen, because there the button is the last
   * thing in a card that has to line up with the card beside it, and anything
   * after it pushes it out of line.
   */
  const pin = adv(el('label', {
    class: 'field',
    style: big ? { marginBottom: '12px' } : { justifyContent: 'center', marginTop: '12px' },
  }, pinToggle, 'pin into the final 128'));

  const button = el('div', { style: { marginTop: big ? '0' : '10px' } },
    // The same button as the collection's, in the same place, at the same
    // size - just not the primary one. Two tiles offering the same kind of
    // choice should not disagree about what a choice looks like.
    el('button', { class: big ? 'btn big wide' : 'btn', onclick: () => input.click() }, 'Choose files'),
    input);

  const zone = el(
    'div',
    { class: 'dropzone' },
    big ? null : el('div', {}, 'Drop .syx files, folders or a .zip here'),
    big ? pin : null,
    button,
    big ? null : pin,
  );

  /*
   * The listeners go on `host`, which is the whole tile on the first screen.
   *
   * Bound to the zone itself, only the strip around the button accepted a
   * drop - so a card that is visibly a target for its whole area rejected
   * files dropped anywhere except one line of it, which is the kind of thing
   * people try once and conclude is broken.
   */
  const target = host ?? zone;
  const stop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  target.addEventListener('dragover', (e) => {
    stop(e as DragEvent);
    target.classList.add('over');
  });
  target.addEventListener('dragleave', (e) => {
    stop(e as DragEvent);
    target.classList.remove('over');
  });
  target.addEventListener('drop', (e) => {
    stop(e as DragEvent);
    target.classList.remove('over');
    const files = [...((e as DragEvent).dataTransfer?.files ?? [])];
    if (files.length) void ingest(files, pinToggle.checked);
  });
  return zone;
}

/**
 * The whole screen, when there is nothing in the corpus yet.
 *
 * The restore line is not decoration. Coming back to an empty browser with a
 * saved session in hand is the second most likely reason to be on this screen,
 * and an onboarding page that only offers .syx files leaves that person with
 * nowhere to put their file.
 */
/**
 * The first screen: the mark, and the two ways in.
 *
 * An empty app has exactly one question to ask and it was asking it as a file
 * dialog with a paragraph of advice underneath. Starting with a prepared
 * collection is the other answer, and where one has been shipped it is the
 * better one - a corpus to listen to immediately instead of fifteen minutes
 * of rendering before anything makes a sound.
 *
 * The collection is offered only if it is actually there. Nothing here tells
 * anybody about a set they cannot have.
 */
/**
 * The two ways to get patches in: a prepared collection, or your own files.
 *
 * The same pair on both screens. It was the splash's alone, which made the
 * collection unreachable the moment you had anything - and the fixes for that
 * kept being routes back to a screen you had finished with. Sources shows the
 * choices at the top and its own business underneath; the splash is the same
 * choices when there is no business yet.
 *
 * The collection appears only if one has actually been shipped. Nothing here
 * tells anybody about a set they cannot have.
 */
function choicesRow(): HTMLElement {
  const choices = el('div', { class: 'splash-choices' });
  /*
   * The card is the drop target.
   *
   * It used to contain one: a dashed box inside a card, each with its own
   * padding and its own version of the same sentence. The card was already a
   * rectangle you can drop files on, and the inner box cost the pair its
   * symmetry - this side came out taller than the collection beside it.
   */
  /*
   * Your own files is there immediately; the collection arrives when it does.
   *
   * Both cards used to be appended inside the manifest's callback, so the
   * whole row waited on a network request before anything was drawn - and on
   * a screen whose entire content is two cards, that reads as the app being
   * slow to open rather than as one card being fetched.
   */
  const scratch = dropCard();
  choices.appendChild(scratch);
  void availableBundles().then((list) => {
    for (const entry of list) choices.insertBefore(bundleCard(entry), scratch);
    if (list.length > 0) choices.classList.add('two');
  });
  return choices;
}

/**
 * Anything dropped on this screen, anywhere on it.
 *
 * Armed on the container rather than on the panel, so the whole window takes a
 * drop and not just the tile that looks like it will - including the dimmed
 * area around the first screen, which is still screen and which people aim at
 * because nothing about it says not to.
 *
 * What arrived decides what happens to it, so there is nothing a target
 * boundary would be protecting.
 */
function armDropTarget(host: HTMLElement): void {
  const result = el('div', { class: 'muted' });
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  host.addEventListener('dragover', (e) => {
    stop(e);
    host.classList.add('drop-armed');
  });
  host.addEventListener('dragleave', (e) => {
    // Only when the cursor has left the host, not on the way between two of
    // its children, which fires dragleave on the one behind.
    if (e.target === host) host.classList.remove('drop-armed');
  });
  host.addEventListener('drop', (e) => {
    stop(e);
    host.classList.remove('drop-armed');
    const files = [...((e as DragEvent).dataTransfer?.files ?? [])];
    if (files.length) void routeDropped(files, false, result);
  });
  host.appendChild(result);
}

function onboarding(): HTMLElement {
  if (splashBusy) return splashProgress();

  const page = el('div', { class: 'onboard splash' },
    splashBusy ? null : el('button', {
      class: 'splash-close',
      title: 'Close',
      onclick: () => {
        splashDismissed = true;
        render();
      },
    }, '×'),
    el('div', { class: 'splash-brand' },
      el('span', { class: 'brand-name' }, 'DX7', el('span', { class: 'brand-sp' }), 'curator')),
    choicesRow(),
    el('div', { class: 'splash-restore' }, exportPanel()),
  );



  // Asynchronous, and the screen is complete without it: the shipped
  // collection appears beside "start from scratch" if there is one, and
  // nothing moves if there is not.
  return page;
}

/**
 * The whole first screen, while something is loading into it.
 *
 * Driven straight off the task stack, so every stage - fetching, unpacking,
 * writing, reading back - is the same bar moving rather than four of them in
 * sequence.
 */
/*
 * Where each stage sits on the one bar.
 *
 * The substeps are separate tasks and each of them counts its own work from
 * zero, so shown raw the bar filled and reset five times over - which reads as
 * five failures rather than one job. Each stage gets a band of the whole
 * instead, and its own progress moves within that band.
 *
 * The widths are roughly what the stages cost on a large collection, measured
 * rather than guessed; they do not have to be exact, only monotonic, because
 * what ruins a progress bar is going backwards and not being slightly wrong
 * about the middle.
 *
 * Anything unrecognised holds the bar where it is rather than moving it
 * somewhere arbitrary - a stage nobody predicted is not a reason to lie.
 */
const LOAD_STAGES: Array<[RegExp, number, number]> = [
  [/^fetching/i, 0, 0.30],
  [/unpacking/i, 0.30, 0.40],
  [/clearing/i, 0.40, 0.42],
  [/writing to the database/i, 0.42, 0.62],
  [/restoring ratings/i, 0.62, 0.65],
  [/restoring measurements/i, 0.65, 0.80],
  [/reading|loading the corpus|matching up/i, 0.80, 0.90],
  [/projecting|grouping|learning/i, 0.90, 0.98],
  [/analysing|near-duplicate|laying out/i, 0.90, 0.99],
];

function splashProgress(): HTMLElement {
  const label = el('div', { class: 'splash-load-label' }, 'Starting up');
  const bar = el('div', { class: 'splash-load-bar' }, el('i', { style: { width: '0%' } }));
  const detail = el('div', { class: 'splash-load-detail muted' }, '');
  splashBar = el('div', { class: 'onboard splash' },
    el('div', { class: 'splash-brand' },
      el('span', { class: 'brand-name' }, 'DX7', el('span', { class: 'brand-sp' }), 'curator')),
    el('div', { class: 'splash-load' }, label, bar, detail),
  );

  let shown = 0;
  const paint = () => {
    const task = activeTask();
    if (!task) return;
    label.textContent = task.label;

    const band = LOAD_STAGES.find(([re]) => re.test(task.label));
    const fill = bar.firstElementChild as HTMLElement;
    if (band) {
      const [, from, to] = band;
      const within = task.fraction === null ? 0 : task.fraction;
      // Never backwards: a stage that starts lower than the last one finished
      // is still further through the job than the last one was.
      shown = Math.max(shown, from + (to - from) * within);
      bar.classList.remove('indeterminate');
      fill.style.width = `${(shown * 100).toFixed(1)}%`;
    } else if (shown === 0) {
      bar.classList.add('indeterminate');
      fill.style.width = '100%';
    }
    detail.textContent = task.detail || (shown > 0 ? `${Math.round(shown * 100)}%` : '');
  };
  splashUnsub?.();
  splashUnsub = subscribeTasks(paint);
  claimTaskDisplay(true);
  paint();
  return splashBar;
}

function endSplashLoad(): void {
  splashBusy = false;
  claimTaskDisplay(false);
  splashUnsub?.();
  splashUnsub = null;
  splashBar = null;
}

function bundleCard(entry: BundleEntry): HTMLElement {
  // No margin while it is empty, or it reserves space for a question nobody
  // has been asked yet.
  const ask = el('div', { class: 'muted' });

  /*
   * Already here, so there is nothing to offer.
   *
   * Every source the collection brought carries its name, which is how this
   * knows. The card stays - it is part of what is in the library and removing
   * it would leave people wondering where the thing they loaded went - but the
   * button goes dead rather than offering to replace a library with a copy of
   * itself, which is the one outcome nobody pressing it could want.
   */
  const loaded = ctx.store.bundleNames().includes(entry.name);
  // No byte count. It is a number nobody weighs anything against, and the one
  // question behind it - how long is this going to take - is answered by the
  // bar that replaces this screen the moment the button is pressed.
  /*
   * Once it is in, it stops being the loud half of the pair.
   *
   * On the first screen the collection is the recommendation and carries the
   * weight; on Sources, with it already loaded, the live choice is the card
   * beside it, and leaving both headings at full strength points at the one
   * thing on the screen that can no longer be done.
   */
  return el('div', { class: loaded ? 'splash-card spent' : 'splash-card primary' },
    el('h2', {}, entry.name),
    el('p', {}, loaded
      ? 'Already loaded. Everything below is from here unless you added more.'
      : entry.note ?? 'Measured, grouped and mapped already.'),
    // Before the button, like the other card's fine print: anything after it
    // takes the bottom edge away from the button, even at zero height, because
    // it still carries a margin.
    ask,
    el('div', { class: 'splash-act' }, el('button', {
      class: loaded ? 'btn big wide' : 'btn primary big wide',
      disabled: loaded,
      title: loaded ? 'These patches are already in this browser' : '',
      onclick: async () => {
        /*
         * Replacing is asked about, because this button can now be reached
         * with a library already in place. A collection is a whole session, so
         * loading one is not a merge - it is everything you have, gone.
         */
        if (ctx.store.voices.length > 0) {
          const ok = await askInPage(ask,
            `Replace all ${fmtInt(ctx.store.voices.length)} patches in this browser with ${entry.name}?`);
          if (!ok) return;
        }
        try {
          splashBusy = true;
          render();
          await runTask(`Fetching ${entry.name}`, async (task) => {
            const bytes = await fetchBundle(entry, (done, total) => {
              task.set(total ? done / total : null, `${(done / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB`);
            });
            task.stage('unpacking');
            const text = await readSessionBytes(bytes);
            await ctx.store.importSession(text, { bundle: entry.name });
          });
          await autoAdvance();
          endSplashLoad();
          /*
           * Straight to the map.
           *
           * The whole point of a prepared collection is that there is nothing
           * to set up, so ending back on the screen you pressed the button on
           * - now showing an import panel - asks you to work out where to go
           * next when the answer is the same every time.
           */
          ctx.go('map');
          return;
        } catch (err) {
          if ((err as Error).name !== 'AbortError') lastNote = `Could not load ${entry.name}: ${(err as Error).message}`;
        }
        endSplashLoad();
        render();
      },
    }, loaded
      ? 'Loaded'
      : entry.voices ? `Load ${fmtInt(entry.voices)} patches` : 'Load it')),
  );
}

async function ingest(files: File[], pinned: boolean): Promise<void> {
  // Dropping files from the first screen gets the same treatment: there is
  // nothing else on it to look at while they are read.
  if (ctx.store.voices.length === 0) {
    splashBusy = true;
    render();
  }
  try {
    await ctx.store.ingestFiles(files, { pinned, userSupplied: pinned });
  } catch (err) {
    lastNote = `Could not read those files: ${(err as Error).message}`;
    endSplashLoad();
    render();
    return;
  }
  await autoAdvance();
  const landed = splashBusy;
  endSplashLoad();
  // Files dropped on the first screen land on the map too, for the same
  // reason: the pipeline has just finished and there is nothing left to do here.
  if (landed && ctx.store.projection) {
    ctx.go('map');
    return;
  }
  render();
}

// ------------------------------------------------------------- the pipeline

/** True when the app is allowed to run the slow passes without being asked. */
function autoPipeline(): boolean {
  return getSetting('pipeline.auto', true);
}

async function runAnalysis(): Promise<void> {
  analysisAbort = new AbortController();
  try {
    await ctx.store.runAnalysis({ signal: analysisAbort.signal });
  } finally {
    analysisAbort = null;
    render();
  }
}

async function runDupes(): Promise<void> {
  if (dupeAbort) return;
  dupeAbort = new AbortController();
  render();
  try {
    await ctx.store.buildClusters({ signal: dupeAbort.signal });
  } catch (err) {
    if ((err as Error).name !== 'AbortError') lastNote = `Near-duplicate pass failed: ${(err as Error).message}`;
    throw err;
  } finally {
    dupeAbort = null;
    render();
  }
}

async function runEmbedding(): Promise<void> {
  if (embedAbort) return;
  embedAbort = new AbortController();
  render();
  try {
    await ctx.store.buildEmbedding({ signal: embedAbort.signal });
  } catch (err) {
    if ((err as Error).name !== 'AbortError') lastNote = `Laying out the map failed: ${(err as Error).message}`;
    throw err;
  } finally {
    embedAbort = null;
    render();
  }
}

/**
 * Carry the corpus as far as it can go on its own.
 *
 * Analysis, then near-duplicates, then the map layout - each only if it has
 * not already been done. Cancelling one stops the chain rather than rolling
 * straight into the next thing you just said no to.
 *
 * The layout is in the chain rather than behind a button because it is the
 * default view, and being told on arrival that the map you are looking at is
 * the second best one and the good one is a button elsewhere is not a choice
 * worth offering. It is also why adding patches re-runs it: the coordinates
 * are per-voice, so new arrivals have no position at all until it does.
 */
async function autoAdvance(): Promise<void> {
  if (advancing || !autoPipeline()) {
    render();
    return;
  }
  advancing = true;
  try {
    if (ctx.store.voices.length > 0 && !ctx.store.analysisComplete) await runAnalysis();
    if (ctx.store.analysisComplete && !ctx.store.graph) await runDupes();
    if (ctx.store.analysisComplete && !ctx.store.embedding && ctx.store.voices.length > 8) await runEmbedding();
  } catch {
    // Cancelled, or failed and already reported. Either way the chain stops
    // and the buttons come back so it can be started again by hand.
  } finally {
    advancing = false;
    render();
  }
}

/** Analysis and de-duplication, as one line of status and at most one button. */
function pipelinePanel(): HTMLElement {
  const store = ctx.store;
  const panel = el('div', { class: 'panel' });
  const pending = store.voices.length - store.analysedCount;
  const running = analysisAbort !== null || dupeAbort !== null || embedAbort !== null;

  const state = running
    ? 'working'
    : pending > 0
      ? 'needs analysis'
      : !store.graph
        ? 'needs de-duplication'
        : !store.embedding
          ? 'needs a map'
          : 'ready';

  panel.appendChild(el('div', { class: 'row' },
    el('h2', { style: { margin: 0 } }, state === 'ready' ? 'Ready' : 'Getting ready'),
    el('div', { style: { flex: '1' } }),

    running
      ? el('button', {
        class: 'btn danger',
        onclick: () => {
          analysisAbort?.abort();
          dupeAbort?.abort();
          embedAbort?.abort();
        },
      }, 'Stop')
      : state !== 'ready'
        ? el('button', { class: 'btn primary', onclick: () => void autoAdvance() },
          pending > 0
            ? `Analyse ${fmtInt(pending)} voices`
            : !store.graph ? 'Find near-duplicates' : 'Lay out the map')
        : null,
  ));

  const bits: string[] = [];
  bits.push(`${fmtInt(store.analysedCount)} of ${fmtInt(store.voices.length)} analysed`);
  if (store.clusters && store.mergeClusters) {
    bits.push(`${fmtInt(store.mergeClusters.clusterCount)} distinct sounds`);
    bits.push(`${fmtInt(store.clusters.clusterCount)} families to rate`);
  }
  if (store.embedding) bits.push('neighbourhood map ready');
  panel.appendChild(el('p', { class: 'hint', style: { margin: '6px 0 0' } }, bits.join('  ·  ')));

  if (store.staleFeatures > 0) {
    panel.appendChild(el('p', { class: 'warn', style: { margin: '8px 0 0' } },
      `${fmtInt(store.staleFeatures)} voices were analysed by an older build and have to be redone. `,
      'Ratings and pins are untouched.'));
  }

  /*
   * The neighbourhood layout, offered rather than run.
   *
   * It is a few seconds of work and the map has a perfectly usable projection
   * without it, so it is not part of the automatic pipeline. It is here rather
   * than on the map because this is where the other expensive passes live.
   */
  if (!running && store.embedding) {
    const redo = el('div', { class: 'row', style: { marginTop: '10px' } },
      el('button', { class: 'btn', onclick: () => void runEmbedding().catch(() => {}) }, 'Lay out the map again'),
      el('span', { class: 'note', style: { flex: '1 1 260px' } },
        'It settles from a fixed start, so this gives the same answer unless the corpus changed.'),
    );
    panel.appendChild(adv(redo) ?? el('span'));
  }

  if (isAdvanced()) {
    panel.appendChild(el('div', { class: 'row', style: { marginTop: '12px' } },
      el('label', {
        class: 'field',
        title: 'Run the analysis and near-duplicate passes on their own after an import.',
      },
        el('input', {
          type: 'checkbox', checked: autoPipeline(),
          onchange: (e: Event) => {
            setSetting('pipeline.auto', (e.target as HTMLInputElement).checked);
            render();
          },
        }), 'run these automatically'),
      store.graph
        ? el('button', { class: 'btn', onclick: () => void runDupes() }, 'Recompute near-duplicates')
        : null,
    ));
  }

  return panel;
}

// ----------------------------------------------------------- read a device

/**
 * Read what is already on the device, before overwriting it.
 *
 * Sending four banks replaces whatever the unit shipped with, and on a clone
 * whose factory content is not published anywhere that is not recoverable. The
 * dump request is the polite way to ask; whether anything answers is up to the
 * device, so the listener runs regardless - on a unit that ignores requests,
 * starting the transmit from its own front panel produces the same bytes and
 * lands here just the same.
 */
function startListening(): void {
  if (listening) return;
  deviceLog = ['listening for a bank…'];
  listening = listenForSysex(({ bytes, from }) => {
    // Anything that is not a voice dump is worth reporting rather than
    // swallowing: it is how you find out the device answered with something
    // else, which is the interesting failure.
    const parsed = parseSysexFile(bytes, `device (${from})`);
    if (parsed.voices.length > 0) {
      deviceBanks.push({ bytes, from, voices: parsed.voices.length, at: Date.now() });
      deviceLog.push(`${fmtInt(parsed.voices.length)} voices from ${from} (${fmtInt(bytes.length)} bytes)`);
    } else {
      const head = [...bytes.slice(0, 5)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      deviceLog.push(`${fmtInt(bytes.length)} bytes from ${from}, no voices in it (starts ${head})`);
    }
    render();
  });
  render();
}

function stopListening(): void {
  listening?.();
  listening = null;
  render();
}

/** Everything received so far, as one file the normal import path can read. */
async function keepDeviceBanks(pinned: boolean): Promise<void> {
  if (deviceBanks.length === 0) return;
  const total = deviceBanks.reduce((n, b) => n + b.bytes.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const b of deviceBanks) {
    all.set(b.bytes, at);
    at += b.bytes.length;
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = new File([all as BlobPart], `device-readback-${stamp}.syx`, { type: 'application/octet-stream' });
  deviceBanks = [];
  await ingest([file], pinned);
}

function devicePanel(): HTMLElement {
  const panel = el('div', {});
  if (!midiSupported()) {
    return el('p', { class: 'muted' }, 'This browser has no WebMIDI, so nothing can be read back here.');
  }
  panel.appendChild(el('div', { class: 'row' },
    el('button', {
      class: 'btn',
      onclick: async () => {
        const state = await requestMidi();
        deviceOutputs = state.outputs;
        deviceOutputId = deviceOutputs[0]?.id ?? '';
        deviceLog.push(state.error ?? `${deviceOutputs.length} out, ${listInputs().length} in`);
        render();
      },
    }, deviceOutputs.length ? 'Rescan MIDI' : 'Connect MIDI'),
    deviceOutputs.length
      ? el('select', {
        onchange: (e: Event) => { deviceOutputId = (e.target as HTMLSelectElement).value; },
      }, ...deviceOutputs.map((o) => el('option', { value: o.id, selected: o.id === deviceOutputId }, `${o.name} ${o.manufacturer}`.trim())))
      : null,
    el('label', { class: 'field', title: 'The MIDI channel the device transmits on, 1 to 16.' }, 'channel',
      el('input', {
        type: 'number', min: 1, max: 16, value: deviceChannel,
        style: { width: '58px' },
        onchange: (e: Event) => { deviceChannel = Number((e.target as HTMLInputElement).value); },
      })),
    el('button', {
      class: listening ? 'btn on' : 'btn',
      onclick: () => (listening ? stopListening() : startListening()),
    }, listening ? 'Stop listening' : 'Listen'),
    el('button', {
      class: 'btn',
      disabled: !deviceOutputId,
      onclick: () => {
        startListening();
        try {
          requestBulkDump(deviceOutputId, Math.max(0, Math.min(15, deviceChannel - 1)));
          deviceLog.push(`asked for a 32-voice dump on channel ${deviceChannel}`);
        } catch (err) {
          deviceLog.push((err as Error).message);
        }
        render();
      },
    }, 'Request a dump'),
  ));

  if (deviceBanks.length) {
    const voices = deviceBanks.reduce((n, b) => n + b.voices, 0);
    panel.appendChild(el('div', { class: 'row', style: { marginTop: '12px' } },
      el('b', {}, `${fmtInt(voices)} voices in ${fmtInt(deviceBanks.length)} dump${deviceBanks.length === 1 ? '' : 's'}`),
      el('button', { class: 'btn', onclick: () => void keepDeviceBanks(false) }, 'Add to corpus'),
      el('button', {
        class: 'btn',
        onclick: () => {
          const total = deviceBanks.reduce((n, b) => n + b.bytes.length, 0);
          const all = new Uint8Array(total);
          let at = 0;
          for (const b of deviceBanks) {
            all.set(b.bytes, at);
            at += b.bytes.length;
          }
          downloadBytes(all, patchFile(`DX7 device read-back ${new Date().toISOString().slice(0, 10)}`));
        },
      }, 'Download as .syx'),
      el('button', {
        class: 'btn danger',
        onclick: () => {
          deviceBanks = [];
          render();
        },
      }, 'Discard'),
    ));
  }

  if (deviceLog.length) {
    panel.appendChild(el('div', { class: 'muted mono', style: { fontSize: '11.5px', marginTop: '10px' } },
      ...deviceLog.slice(-6).map((line) => el('div', {}, line))));
  }
  return panel;
}

// --------------------------------------------------------- the sweep table

function sweepTable(): HTMLElement {
  const store = ctx.store;
  const rows = store.sweep(SWEEP_POINTS);
  if (rows.length === 0) return el('p', { class: 'muted' }, 'No candidate pairs yet.');

  const wrap = el('div', {});
  const table = el('table', { class: 'data sweep' });
  table.appendChild(el('thead', {}, el('tr', {},
    el('th', {}, ''),
    el('th', {}, 'distance'),
    el('th', { class: 'num' }, 'groups'),
    el('th', { class: 'num' }, 'collapsed'),
    el('th', { class: 'num' }, 'largest'),
    ...SIZE_BUCKETS.map((b) => el('th', { class: 'num' }, `size ${b[2]}`)),
    el('th', {}, 'set as'),
  )));
  const body = el('tbody');

  for (const row of rows) {
    const inMerge = row.threshold <= store.mergeThreshold + 1e-9;
    const inFamily = !inMerge && row.threshold <= store.threshold + 1e-9;
    const isMergeEdge = Math.abs(row.threshold - store.mergeThreshold) < 1e-9;
    const isFamilyEdge = Math.abs(row.threshold - store.threshold) < 1e-9;

    const zone = inMerge ? 'merged' : inFamily ? 'family' : 'apart';
    const marker = isMergeEdge && isFamilyEdge
      ? 'merge + family cut-off'
      : isMergeEdge ? 'merge cut-off' : isFamilyEdge ? 'family cut-off' : '';

    body.appendChild(el('tr', { class: `zone-${zone}${marker ? ' zone-edge' : ''}` },
      el('td', { class: 'zone-cell' }, el('span', { class: 'zone-bar' }), marker
        ? el('span', { class: 'zone-label' }, marker)
        : null),
      el('td', { class: 'mono' }, row.threshold.toFixed(2)),
      el('td', { class: 'num' }, fmtInt(row.clusters)),
      el('td', { class: 'num' }, fmtInt(row.collapsed)),
      el('td', { class: 'num' }, fmtInt(row.largest)),
      ...row.sizeBuckets.map((n) => el('td', { class: 'num muted' }, fmtInt(n))),
      el('td', { style: { whiteSpace: 'nowrap' } },
        el('button', {
          class: isMergeEdge ? 'btn on' : 'btn',
          style: { padding: '2px 8px', marginRight: '6px' },
          title: `Treat everything at or below ${row.threshold.toFixed(2)} as the same patch`,
          onclick: () => {
            store.applyThreshold(Math.max(store.threshold, row.threshold), row.threshold);
            render();
          },
        }, 'merge'),
        el('button', {
          class: isFamilyEdge ? 'btn on' : 'btn',
          style: { padding: '2px 8px' },
          title: `Treat everything at or below ${row.threshold.toFixed(2)} as one face-off family`,
          onclick: () => {
            store.applyThreshold(row.threshold, Math.min(store.mergeThreshold, row.threshold));
            render();
          },
        }, 'family'),
      ),
    ));
  }
  table.appendChild(body);
  wrap.appendChild(table);

  wrap.appendChild(el('div', { class: 'legend', style: { marginTop: '10px' } },
    el('span', {}, el('i', { class: 'swatch-merged' }), 'merged'),
    el('span', {}, el('i', { class: 'swatch-family' }), 'family'),
    el('span', {}, el('i', { class: 'swatch-apart' }), 'unrelated'),
  ));

  return wrap;
}

// ------------------------------------------------- where the good ones are

let sourceLevel: SourceLevel = getSetting<SourceLevel>('sources.level', 'archive');
let sourceBy: 'score' | 'expected' = getSetting<'score' | 'expected'>('sources.by', 'score');
let sourceWorst = false;
let sourceRows: SourceScore[] | null = null;

/**
 * Which of the files you dropped in were worth it.
 *
 * Ranking is in sourceRanking.ts, including why the order is not by the
 * average you can see. This is the table and the three controls.
 */
function sourcePanel(): HTMLElement {
  const wrap = el('div', {});
  const body = el('div', {});

  const compute = async () => {
    const store = ctx.store;
    const wantPredictions = sourceBy === 'expected' && store.tasteModel !== null;
    if (wantPredictions) {
      const all = store.voices.map((_, i) => i);
      await runTask('guessing what is in each file', async (task) => {
        await store.fillPredictions(all, async (done, total) => {
          task.set(total ? done / total : null, `${fmtInt(done)} of ${fmtInt(total)}`);
          await new Promise((r) => setTimeout(r, 0));
        });
      });
    }
    sourceRows = rankSources({
      count: store.voices.length,
      filesOf: (i) => store.voices[i].sources.map((src) => src.file),
      ratingOf: (i) => store.effectiveRating(i),
      predictedOf: wantPredictions ? (i) => store.predictedRating(i) : undefined,
      level: sourceLevel,
    });
  };

  const fill = () => {
    clear(body);
    const rows = sortSources(sourceRows ?? [], sourceBy, sourceWorst)
      .filter((r) => (sourceBy === 'score' ? r.score !== null : r.expected !== null));
    if (rows.length === 0) {
      body.appendChild(el('p', { class: 'muted' }, sourceBy === 'score'
        ? 'Rate a few patches and this fills in.'
        : 'The model needs a few more ratings before it can guess.'));
      return;
    }

    const table = el('table', { class: 'data fixed' });
    table.appendChild(el('thead', {}, el('tr', {},
      el('th', {}, sourceLevel),
      el('th', { class: 'num src-num' }, 'voices'),
      el('th', { class: 'num src-num' }, 'rated'),
      el('th', { class: 'num src-num' }, 'average'),
      el('th', { class: 'num src-num' }, 'expected'),
      el('th', { class: 'src-bar' }, ''),
    )));
    const tbody = el('tbody');
    for (const row of rows.slice(0, SOURCE_ROWS)) {
      const shown = sourceBy === 'score' ? row.average : row.expected;
      const cut = row.key.lastIndexOf('/');
      tbody.appendChild(el('tr', {
        class: 'clickable',
        title: `${row.key}\nClick to browse everything that came from here`,
        onclick: () => void browseSource(row.key),
      },
        el('td', { class: 'src-name' },
          cut >= 0 ? el('span', { class: 'muted' }, row.key.slice(0, cut + 1)) : null,
          el('span', {}, cut >= 0 ? row.key.slice(cut + 1) : row.key)),
        el('td', { class: 'num src-num' }, fmtInt(row.voices)),
        el('td', { class: 'num muted src-num' }, row.rated > 0 ? fmtInt(row.rated) : '-'),
        el('td', { class: 'num src-num' }, row.average === null ? '-' : row.average.toFixed(2)),
        el('td', { class: 'num muted src-num' }, row.expected === null ? '-' : row.expected.toFixed(2)),
        el('td', { class: 'src-bar' }, el('div', { class: 'stat-bar' }, el('i', {
          style: {
            left: '0',
            width: `${Math.max(2, Math.min(1, (shown ?? 0) / 5) * 100)}%`,
            background: ratingColour(Math.round(shown ?? 0)),
          },
        }))),
      ));
    }
    table.appendChild(tbody);
    body.appendChild(table);

    if (rows.length > SOURCE_ROWS) {
      body.appendChild(el('p', { class: 'muted', style: { marginTop: '8px' } },
        `${fmtInt(rows.length - SOURCE_ROWS)} more not shown.`));
    }
  };

  const redraw = async (recompute: boolean) => {
    if (recompute) await compute();
    fill();
  };

  // The direction is a property of the same table, so it updates in place
  // rather than through a rebuild of the screen around it.
  const flip = el('button', {
    class: sourceWorst ? 'btn on' : 'btn',
    title: 'The other end of the list - the folders worth deleting',
    onclick: () => {
      sourceWorst = !sourceWorst;
      flip.className = sourceWorst ? 'btn on' : 'btn';
      flip.textContent = sourceWorst ? 'worst first' : 'best first';
      fill();
    },
  }, sourceWorst ? 'worst first' : 'best first');

  wrap.appendChild(el('div', { class: 'row' },
    el('select', {
      title: 'How much of the path to group by',
      onchange: (e: Event) => {
        sourceLevel = (e.target as HTMLSelectElement).value as SourceLevel;
        setSetting('sources.level', sourceLevel);
        void redraw(true);
      },
    }, ...SOURCE_LEVELS.map((l) => el('option', { value: l.id, selected: l.id === sourceLevel }, `by ${l.label}`))),
    el('select', {
      title: 'Rank by the ratings you gave, or by the model filling in the rest',
      onchange: (e: Event) => {
        sourceBy = (e.target as HTMLSelectElement).value as 'score' | 'expected';
        setSetting('sources.by', sourceBy);
        void redraw(true);
      },
    },
      el('option', { value: 'score', selected: sourceBy === 'score' }, 'by your ratings'),
      el('option', { value: 'expected', selected: sourceBy === 'expected' }, 'by expected'),
    ),
    flip,
  ));
  wrap.appendChild(body);
  wrap.appendChild(el('p', { class: 'note' },
    'Ordered by an average pulled toward the corpus mean, so one lucky five-star patch in a file of three does not beat a folder of sixty good ones.'));

  void redraw(true);
  return wrap;
}

/** Open Browse with everything from one source, using the search's own syntax. */
async function browseSource(key: string): Promise<void> {
  const map = await import('./map.ts');
  map.presetSearch(`"${key}"`);
  ctx.go('map');
}

// ------------------------------------------------------------ save and load

/**
 * Getting things out, and back in.
 *
 * Two files, and the difference between them used to be buried in a paragraph
 * nobody reads: one carries the patches, the other carries only what you
 * decided about them. Restoring the second one into a browser that has never
 * seen the patches matches nothing and looks exactly like a broken button, so
 * both the names and the result now say which is which.
 */
/**
 * Ask a yes/no question inside the page and wait for the answer.
 *
 * The one thing confirm() has over this is that it blocks; the several things
 * this has over confirm() are that it cannot be suppressed by the browser, it
 * cannot be mistaken for a phishing dialog, and it is visible in a screenshot
 * when someone reports that a button did nothing.
 */
/**
 * Restore a saved file, whichever of the two kinds it is.
 *
 * A full session replaces everything; a ratings file reapplies decisions to a
 * corpus you already have. Which one it is comes out of the file rather than
 * out of a choice the user has to make first.
 */
async function restoreFile(file: File, result: HTMLElement): Promise<void> {
  const store = ctx.store;
  // Read as bytes and sniff: a session may be gzipped, and a ratings file or
  // an older session is plain text. readSessionBytes handles both.
  const text = await readSessionBytes(new Uint8Array(await file.arrayBuffer()));
  clear(result);
  try {
    if (Store.isSession(text)) {
      /*
       * Asked in the page, not through confirm().
       *
       * A browser is allowed to suppress confirm() - after a few dialogs
       * Chrome offers to stop showing them, and some embedded contexts never
       * show them at all - and a suppressed confirm() returns false. This used
       * to be `if (!confirm(...)) return;`, so in exactly those browsers
       * loading a session did nothing whatsoever: no dialog, no import, no
       * error, no message. A question drawn in the page cannot be suppressed,
       * and answering no now says so instead of looking like a broken button.
       *
       * And it is only asked when there is something to lose.
       */
      if (store.voices.length > 0) {
        const ok = await askInPage(result,
          `Replace all ${fmtInt(store.voices.length)} patches in this browser with the session in that file?`);
        if (!ok) {
          result.className = 'muted';
          result.textContent = 'Left everything as it was.';
          return;
        }
      }
      splashBusy = store.voices.length === 0;
      if (splashBusy) render();
      const { voices } = await store.importSession(text);
      await autoAdvance();
      const landed = splashBusy;
      endSplashLoad();
      if (landed && store.projection) {
        ctx.go('map');
        return;
      }
      result.className = 'good';
      result.textContent = `Restored ${fmtInt(voices)} voices and their ratings.`;
      render();
      return;
    }

    const r = await store.importBackup(text);
    const applied = r.ratings + r.overrides + r.pinned;
    result.className = applied > 0 ? 'good' : 'warn';
    result.textContent = applied > 0
      ? `Restored ${fmtInt(r.ratings)} ratings, ${fmtInt(r.overrides)} category overrides and ${fmtInt(r.pinned)} pins.`
        + (r.missing ? ` ${fmtInt(r.missing)} referred to patches this corpus does not have.` : '')
      : `Nothing applied: all ${fmtInt(r.missing)} entries refer to patches that are not in this corpus. `
        + 'This file holds ratings only - import the patches themselves first, or use a full session file.';
  } catch (err) {
    endSplashLoad();
    result.className = 'bad';
    result.textContent = `Could not read that file: ${(err as Error).message}`;
  }
  render();
}

/**
 * Work out what somebody just dropped, and do the right thing with it.
 *
 * Dragging a file onto the first screen should not require having first
 * decided which of two buttons it belongs to. A saved session and a bank of
 * patches are told apart by looking: gzip has a two-byte signature and JSON
 * starts with a brace, and anything else is sysex.
 *
 * Mixed drops go to the patch path, since a session is a whole state and
 * cannot be merged with anything.
 */
async function routeDropped(files: File[], pinned: boolean, result: HTMLElement): Promise<void> {
  const saved: File[] = [];
  const patches: File[] = [];
  for (const f of files) {
    const head = new Uint8Array(await f.slice(0, 2).arrayBuffer());
    const isGzip = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
    const isJson = head.length >= 1 && (head[0] === 0x7b || head[0] === 0x20 || head[0] === 0x0a);
    // A zip also starts with 'P', not a brace, so it lands in patches where it
    // belongs; only gzip and JSON are ever a saved file.
    (isGzip || isJson ? saved : patches).push(f);
  }
  if (saved.length > 0 && patches.length === 0) {
    await restoreFile(saved[0], result);
    return;
  }
  if (patches.length > 0) await ingest(patches, pinned);
}

function askInPage(host: HTMLElement, question: string, confirmLabel = 'Replace'): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value: boolean) => {
      if (answered) return;
      answered = true;
      clear(host);
      resolve(value);
    };
    clear(host);
    host.className = 'warn';
    host.appendChild(el('div', { class: 'row' },
      el('span', {}, question),
      el('button', { class: 'btn danger', onclick: () => answer(true) }, confirmLabel),
      el('button', { class: 'btn', onclick: () => answer(false) }, 'Cancel'),
    ));
  });
}

function exportPanel(): HTMLElement {
  const store = ctx.store;
  const result = el('div', { class: 'muted', style: { marginTop: '10px' } });

  const restoreInput = el('input', {
    type: 'file',
    accept: '.json,.gz,application/json,application/gzip',
    style: { display: 'none' },
    onchange: async () => {
      const file = restoreInput.files?.[0];
      restoreInput.value = '';
      if (file) await restoreFile(file, result);
    },
  }) as HTMLInputElement;

  const empty = store.voices.length === 0;
  /*
   * With nothing loaded this is one button and does not deserve a card.
   *
   * A heading, a border and a sentence around a single quiet action made it
   * look like a third choice competing with the two above it, which it is not
   * - it is for the one person who already has a file.
   */
  const panel = el('div', { class: empty ? 'bare' : 'panel' },
    empty ? null : el('h2', {}, 'Save and load'),
    el('div', { class: 'row' },
      empty ? el('button', { class: 'btn', onclick: () => restoreInput.click() }, 'Load a saved file') : null,
      empty ? restoreInput : null,
      empty ? null : el('button', {
        class: 'btn',
        title: 'Patches and ratings together. This is the one to move to another machine.',
        onclick: () => {
          void runTask('packing the session', async (task) => {
            task.set(null, 'gathering');
            await new Promise((r) => setTimeout(r, 0));
            const json = store.exportSession();
            task.set(null, 'compressing');
            await new Promise((r) => setTimeout(r, 0));
            const bytes = await gzip(json);
            downloadBytes(bytes, patchFile(`DX7 session ${new Date().toISOString().slice(0, 10)}`, 'json.gz'));
          });
        },
      }, `Full session (${fmtInt(store.voices.length)} patches, ratings and measurements)`),
      empty ? null : el('button', {
        class: 'btn',
        disabled: store.ratings.size === 0 && !store.voices.some((v) => v.pinned),
        title: 'Ratings, pins and category overrides only, keyed by patch content. Reapplies to a corpus you already have.',
        onclick: () => {
          const blob = new TextEncoder().encode(store.exportBackup());
          downloadBytes(blob, patchFile(`DX7 ratings ${new Date().toISOString().slice(0, 10)}`, 'json'));
        },
      }, `Ratings only (${fmtInt(store.ratings.size)})`),
      empty ? null : el('button', {
        class: 'btn',
        title: 'The deduplicated corpus as back-to-back 32-voice bulk dumps, which is what every other DX7 tool reads.',
        onclick: () => {
          const { bytes, voices } = store.exportDedupedSyx();
          downloadBytes(bytes, patchFile(`DX7 corpus, ${voices} voices`));
        },
      }, 'Deduped .syx'),
      // Loading is the opposite of the three beside it and was sitting in the
      // middle of them, so it reads as one more thing to save until you have
      // read all four labels. Last, behind a rule.
      empty ? null : el('span', { class: 'bar-sep' }),
      empty ? null : el('button', { class: 'btn', onclick: () => restoreInput.click() }, 'Load a file…'),
      empty ? null : restoreInput,
    ),
    result,
  );
  return panel;
}

// -------------------------------------------------------------------- page

function render(): void {
  const store = ctx.store;
  clear(container);
  // The whole view takes a drop, on either screen: the scrim is a child of
  // this, so events from it bubble here too.
  armDropTarget(container);

  /*
   * An empty library always gets the splash, advanced or not.
   *
   * It used to be hidden whenever the advanced switch was on, which is fine
   * until you press "delete everything" - a button that only exists under that
   * switch - and land on a Sources screen with no way back to the two things
   * you might now want to do. The advanced panels still follow it.
   */
  if (store.voices.length === 0 && !splashDismissed) {
    /*
     * Lifted off the page, on a scrim.
     *
     * With nothing in the library the screen behind this is an empty Sources
     * panel, and laying the choice flat on top of it made the two read as one
     * page where half the controls did nothing. A scrim says the rest is not
     * available yet, which is true, and gives the mark and the two cards a
     * surface of their own to sit on.
     */
    container.appendChild(el('div', { class: 'splash-scrim' }, onboarding()));
    /*
     * Hardware, for the person who has a synth and no files.
     *
     * A whole panel for it made the first screen look like a settings page, so
     * it is a collapsed line under the two choices - still there for the one
     * case that needs it, and worth nothing of the screen until asked for.
     */
    if (isAdvanced() && !splashBusy) {
      container.appendChild(el('div', { class: 'stack page-narrow about-device' },
        // Folded, and not remembering it was ever open: here it is the third
        // answer to a question nearly everybody answers with one of the two
        // above it.
        disclosure('Or read them off a device', devicePanel)));
    }
    return;
  }

  const page = el('div', { class: 'stack page-narrow' });
  page.appendChild(pageHead('Sources'));

  if (lastNote) {
    page.appendChild(el('p', { class: 'bad' }, lastNote));
    lastNote = '';
  }

  // The same two choices the first screen offers, at the top of the screen you
  // would go to in order to make either of them.
  page.appendChild(choicesRow());
  if (store.voices.length > 0) {
    page.appendChild(pipelinePanel());
    if (store.lastIngest) {
      page.appendChild(el('div', { class: 'panel' }, lastImport(store.lastIngest)));
    }

  }

  if (store.voices.length > 0 && (store.ratings.size > 0 || store.tasteModel)) {
    page.appendChild(el('div', { class: 'panel' },
      disclosure('Where the good ones come from', sourcePanel, {
        key: 'sourceScores',
        note: `${fmtInt(store.ratings.size)} rated`,
      })));
  }

  page.appendChild(exportPanel());

  if (isAdvanced()) {
    page.appendChild(el('div', { class: 'panel' },
      disclosure('Read patches off a device', devicePanel, { key: 'device' }),
      store.graph
        ? disclosure('Near-duplicate thresholds', sweepTable, {
          key: 'sweep',
          note: `merge ${store.mergeThreshold.toFixed(2)}  ·  family ${store.threshold.toFixed(2)}`,
        })
        : null,
      disclosure('Start over', dangerZone, { key: 'danger' }),
    ));
  }

  container.appendChild(page);
}

/** What the last import did, as a line, with the awkward parts on request. */
function lastImport(s: NonNullable<typeof ctx.store.lastIngest>): HTMLElement {
  const awkward = s.skipped.length > 0 || s.errors.length > 0 || s.checksumFailures > 0 || s.clampedBytes > 0;
  const wrap = el('div', { style: { marginTop: '12px' } },
    el('p', { class: 'muted', style: { margin: 0, fontSize: '12px' } },
      `Last import: ${fmtInt(s.voicesRead)} voices read from ${fmtInt(s.files)} file${s.files === 1 ? '' : 's'} — `,
      el('b', { class: 'good' }, `${fmtInt(s.added)} new`), `, ${fmtInt(s.merged)} already known`,
      s.rejected ? `, ${fmtInt(s.rejected)} init or silent` : '',
    ));

  if (!awkward) return wrap;

  wrap.appendChild(disclosure('What was skipped', () => {
    const body = el('div', {});
    if (s.skipped.length) {
      const ul = el('ul', { class: 'muted', style: { margin: '0 0 8px', paddingLeft: '18px' } });
      for (const sk of s.skipped) ul.appendChild(el('li', {}, `${sk.reason}: ${fmtInt(sk.count)}`));
      body.appendChild(ul);
    }
    if (s.clampedBytes) {
      body.appendChild(el('p', { class: 'muted', style: { margin: '0 0 8px' } },
        `${fmtInt(s.clampedBytes)} out-of-range bytes were clamped.`));
    }
    if (s.checksumFailures) {
      body.appendChild(el('p', { class: 'warn', style: { margin: '0 0 8px' } },
        `${fmtInt(s.checksumFailures)} voices came from a dump whose checksum did not verify. `,
        'Kept anyway — usually a sloppy archiver rather than corrupt data — but worth a listen.'));
    }
    if (s.errors.length) {
      const ul = el('ul', { class: 'bad', style: { margin: 0, paddingLeft: '18px' } });
      for (const e of s.errors.slice(0, 12)) ul.appendChild(el('li', {}, `${e.file}: ${e.error}`));
      if (s.errors.length > 12) ul.appendChild(el('li', {}, `and ${fmtInt(s.errors.length - 12)} more`));
      body.appendChild(ul);
    }
    return body;
  }, { note: `${fmtInt(s.skipped.reduce((n, x) => n + x.count, 0) + s.errors.length)} entries` }));

  return wrap;
}

function dangerZone(): HTMLElement {
  const store = ctx.store;
  // Asked in the page for the same reason the restore is: a browser may
  // suppress confirm(), and a suppressed confirm() returns false - which for a
  // destructive button means it silently does nothing, and for the one beside
  // it meant a restore that appeared to fail.
  const ask = el('div', { class: 'muted', style: { marginTop: '10px' } });
  return el('div', {},
    el('div', { class: 'row' },
      el('button', {
        class: 'btn danger',
        disabled: store.ratings.size === 0 && store.faceoffExtras.size === 0,
        onclick: async () => {
          const ok = await askInPage(ask,
            `Delete all ${fmtInt(store.ratings.size)} ratings and ${fmtInt(store.faceoffExtras.size)} face-off results? `
            + 'The patches and their analysis are kept.', 'Delete ratings');
          if (!ok) return;
          await ctx.store.resetRatings();
          render();
        },
      }, `Reset all ratings (${fmtInt(store.ratings.size)})`),
      el('button', {
        class: 'btn danger',
        onclick: async () => {
          const ok = await askInPage(ask,
            `Delete all ${fmtInt(store.voices.length)} patches, their measurements and every rating? This cannot be undone.`,
            'Delete everything');
          if (!ok) return;
          await ctx.store.reset();
          render();
        },
      }, 'Delete everything'),
    ),
    ask,
  );
}

export const view: View = {
  mount(el_, c) {
    ctx = c;
    container = el_;
    unsubscribe = c.store.subscribe(() => {
      // The progress bar updates itself; a full rebuild mid-pass would fight
      // the user's scroll for no gain.
      if (!analysisAbort && !dupeAbort) render();
    });
    render();
    // Anything left half-done from a previous visit carries on by itself.
    void autoAdvance();
  },
  unmount() {
    unsubscribe?.();
    unsubscribe = null;
    analysisAbort?.abort();
    // Leaving the screen releases the inputs back to the keyboard handler.
    listening?.();
    listening = null;
  },
};
