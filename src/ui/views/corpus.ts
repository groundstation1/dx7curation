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
import { clearSettings, getSetting, setSetting } from '../settings.ts';
import { gzip, readSessionBytes } from '../session.ts';
import { availableBundles, bundlesNow, fetchBundle, type BundleEntry } from '../bundles.ts';
import { Store, looksLikeVoiceFile } from '../state.ts';
import { SIZE_BUCKETS } from '../../cluster/nearDupe.ts';
import { listenForSysex, listInputs, midiSupported, requestBulkDump, requestMidi, type MidiPort } from '../../midi/webmidi.ts';
import { parseSysexFile } from '../../sysex/parse.ts';
import { topTerms } from '../../cluster/taste.ts';
import { CATEGORY_LABELS, type Category } from '../../cluster/category.ts';
import { categoryColour } from '../colour.ts';
import { FEATURE_DEFS } from '../../features/vector.ts';
import { runTask } from '../task.ts';
import { loadBlock, loadingBrand, type LoadBlock, type LoadBands } from '../loading.ts';
import { dropPendingLink, peekPendingLink, patchLinkFor } from '../patchLink.ts';
import { sendToDeviceButton } from '../midiOut.ts';
import { unpackVoice, voiceName } from '../../sysex/voice.ts';
import { buildSingleVoice } from '../../sysex/write.ts';
import { DEMO_PHRASE } from '../../engine/phrase.ts';
import { keyboard } from '../../audio/keyboard.ts';
import { P } from '../../sysex/voice.ts';
import { algorithmPanel } from '../algorithmDiagram.ts';

const SWEEP_POINTS = [0.01, 0.02, 0.03, 0.05, 0.08, 0.12, 0.16, 0.22, 0.3];

/** Where to get a lot of patches at once, for someone who has none. */

let ctx: ViewContext;
let container: HTMLElement;
let unsubscribe: (() => void) | null = null;
let dupeAbort: AbortController | null = null;
let embedAbort: AbortController | null = null;
/** Stops the whole automatic chain, whichever pass it is on. */
let chainAbort: AbortController | null = null;
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
    // Both sentences in the one paragraph, because they are one thought and
    // because a separate line of fine print underneath is a second typographic
    // register for something nobody was worried about until it appeared.
    el('p', {}, 'Drop .syx files, a folder or a zip.', el('br'),
      'Everything stays on your machine.'),
    act,
  );
  const pin = inner.querySelector('.field');
  if (pin) card.insertBefore(pin, act);
  return card;
}

/*
 * Everything that was dropped, folders opened up.
 *
 * `DataTransfer.files` lists a dropped directory as one File that is not a
 * file: no type, a nonsense size, and reading it rejects with "The operation
 * was aborted" - which is exactly what somebody dropping a folder of banks
 * got, under a card that invites them to drop a folder.
 *
 * The contents are only reachable through the entries API, so that is what
 * this walks. Files sitting loose in the drop are taken as they are, because
 * pointing at a file is a choice; files found inside a folder are filtered the
 * same way a zip's entries are, because pointing at a folder is not a choice
 * about the readme inside it.
 *
 * `webkitGetAsEntry` has to be called while the event is still live - the item
 * list is emptied as soon as the handler returns - so every entry is collected
 * before anything is awaited.
 */
async function filesFromDrop(dt: DataTransfer | null): Promise<File[]> {
  if (!dt) return [];
  const flat = [...dt.files];
  const entries = [...(dt.items ?? [])]
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length === 0) return flat;

  const out: File[] = [];
  const fileOf = (entry: FileSystemFileEntry) => new Promise<File | null>((resolve) => {
    entry.file((f) => resolve(f), () => resolve(null));
  });
  const batchOf = (reader: FileSystemDirectoryReader) => new Promise<FileSystemEntry[]>((resolve) => {
    reader.readEntries((batch) => resolve(batch), () => resolve([]));
  });

  const walk = async (entry: FileSystemEntry, inFolder: boolean): Promise<void> => {
    if (entry.isFile) {
      const file = await fileOf(entry as FileSystemFileEntry);
      if (!file) return;
      if (inFolder && !looksLikeVoiceFile(file.name, file.size)) return;
      out.push(file);
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries hands back at most a hundred at a time and signals the end
    // with an empty batch, so it has to be asked until it gives one.
    for (;;) {
      const batch = await batchOf(reader);
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, true);
    }
  };

  for (const entry of entries) await walk(entry, false);
  // A browser that gave us entries but no readable files at all is better
  // served by the flat list than by nothing.
  return out.length > 0 ? out : flat;
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
  }, pinToggle, 'mark as favourites'));

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
    const pinned = pinToggle.checked;
    void filesFromDrop((e as DragEvent).dataTransfer).then((files) => {
      if (files.length) void ingest(files, pinned);
    });
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
  const fill = (list: BundleEntry[]) => {
    for (const entry of list) choices.insertBefore(bundleCard(entry), scratch);
    if (list.length > 0) choices.classList.add('two');
  };
  // Already known on every render but the very first, and usually on that one
  // too because the boot prefetches it - so the pair arrives together instead
  // of the collection dropping in a moment after the screen.
  const known = bundlesNow();
  if (known) fill(known);
  else void availableBundles().then(fill);
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
    void filesFromDrop((e as DragEvent).dataTransfer).then((files) => {
      if (files.length) void routeDropped(files, false, result);
    });
  });
  host.appendChild(result);
}

/**
 * Somebody sent you a patch and you have never been here before.
 *
 * The whole of this app is about a corpus, and there is no corpus - so none of
 * it applies. What applies is the one sound in the URL: hear it, keep the file
 * if you want it, and be told what the place you have landed in is for.
 *
 * Nothing is written to the database. The patch is played straight out of the
 * bytes in the link, which the engine is perfectly happy to do, so arriving
 * here costs nothing and leaves nothing behind. Taking up the offer on the
 * right forgets it, which is the correct weight for a link: you were shown a
 * sound, not handed a library.
 */
/*
 * Which linked patches have already played by themselves.
 *
 * This screen is redrawn whenever the store changes - and on a revisit the
 * store changes several times over while the pipeline finishes - so without
 * this every redraw started the phrase again from the top.
 */
const landingPlayed = new Set<string>();

function linkLanding(packed: Uint8Array): HTMLElement {
  const unpacked = unpackVoice(packed);
  const name = voiceName(unpacked) || '(unnamed)';
  // Armed straight away, so a MIDI or typing keyboard plays it without anyone
  // having to find a button first.
  keyboard.setPatch(unpacked);

  const play = el('button', {
    class: 'btn primary big wide',
    onclick: () => {
      void ctx.player.unlock().then(() => ctx.player.audition(`link:${name}`, unpacked, DEMO_PHRASE));
    },
  }, 'Play it');

  const patchCard = el('div', { class: 'splash-card primary' },
    el('h2', {}, name),
    el('p', {}, 'Somebody sent you this patch. It travelled inside the link — ',
      'there is no copy of it anywhere but the address bar you just opened.'),
    el('p', { class: 'muted' },
      `algorithm ${(unpacked[P.algorithm] & 31) + 1}`,
      `  ·  feedback ${unpacked[P.feedback] & 7}`),
    /*
     * The same diagram the sidebar draws, because this one can be drawn.
     *
     * Most of the voice panel is measurements, and there are none here - the
     * patch was never imported, so it has no features, no category and no
     * neighbours. The algorithm is different: it is read straight out of the
     * bytes, and it is the part that tells you what kind of instrument you are
     * looking at. Clicking an operator opens its envelope, exactly as it does
     * everywhere else in the app.
     */
    el('div', { class: 'link-diagram' },
      algorithmPanel(unpacked[P.algorithm] & 31, unpacked)),
    el('div', { class: 'splash-act' }, play),
    el('div', { class: 'link-keep' },
      el('button', {
        class: 'btn quiet',
        onclick: () => downloadBytes(buildSingleVoice(unpacked), patchFile(name)),
      }, '\u2193 .syx'),
      el('button', {
        class: 'btn quiet',
        onclick: (e: Event) => {
          const b = e.currentTarget as HTMLButtonElement;
          void navigator.clipboard.writeText(patchLinkFor(packed, name)).then(() => {
            b.textContent = 'copied';
            window.setTimeout(() => { b.textContent = '\u21d7 link'; }, 1400);
          }, () => {});
        },
      }, '\u21d7 link'),
      // Somebody sent you a sound and the synth is plugged in: this is the
      // shortest possible route from the link to your hands.
      sendToDeviceButton(unpacked, 'btn quiet')),
  );

  /*
   * What is offered beside the patch depends on whether there is a library.
   *
   * With nothing here, the useful offer is the app itself - this is somebody's
   * first sight of it. With a library already in place the patch is simply not
   * in it, and the only thing anyone wants is a button that puts it there.
   */
  const store = ctx.store;
  const offer = store.voices.length === 0
    ? el('div', { class: 'splash-card' },
      el('h2', {}, 'The rest of it'),
      el('p', {}, 'DX7 curator cuts tens of thousands of patches down to the hundred and ',
        'twenty-eight worth keeping. Bring your own, or start from a library of thirty thousand.'),
      el('div', { class: 'splash-fine' }, 'Everything stays on your machine.'),
      el('div', { class: 'splash-act' }, el('button', {
        class: 'btn big wide',
        onclick: () => {
          // Let go of here. It was never in the library, so there is nothing
          // to remove - and the link still works if they kept it.
          dropPendingLink();
          ctx.player.stop();
          render();
        },
      }, 'Have a look')))
    : el('div', { class: 'splash-card primary' },
      el('h2', {}, 'Not in your library'),
      el('p', {}, `None of your ${fmtInt(store.voices.length)} patches has these parameters. `,
        'Add it and it gets measured, grouped and placed on the map with the rest, and can be '
        + 'rated and built into a bank.'),
      el('div', { class: 'splash-act' }, el('button', {
        class: 'btn primary big wide',
        onclick: async () => {
          dropPendingLink();
          const at = await store.addSynthesised(unpacked, name, 'shared link', {
            pinned: false, bank: 'link',
          });
          await autoAdvance();
          if (at !== null && at >= 0 && store.projection) {
            const map = await import('./map.ts');
            map.presetSelect(at, { play: true });
            ctx.go('map');
            return;
          }
          render();
        },
      }, 'Add to library')),
      el('div', { class: 'link-keep' }, el('button', {
        class: 'btn quiet',
        onclick: () => {
          dropPendingLink();
          ctx.player.stop();
          ctx.go(store.projection ? 'map' : 'corpus');
        },
      }, 'Not now')));

  /*
   * It plays by itself, because the link was about the sound.
   *
   * Treated as a click rather than a hover, so it obeys the same setting as
   * every other deliberate audition and stays silent for anyone who has turned
   * auto-play off. A browser may refuse to make noise before the page has been
   * touched, and nothing can be done about that - which is why the button is
   * there, and why the keyboard is armed either way.
   */
  // Only if the browser will let it play now - see Player.canPlayNow. The
  // Play button is right there when it will not.
  if (ctx.player.mayPlay('click') && !landingPlayed.has(name)) {
    landingPlayed.add(name);
    void ctx.player.canPlayNow().then((ok) => {
      if (ok) void ctx.player.audition(`link:${name}`, unpacked, DEMO_PHRASE);
    });
  }

  return el('div', { class: 'onboard splash' },
    loadingBrand(),
    el('div', { class: 'splash-choices two' }, patchCard, offer),
  );
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
 * sequence. The bands are roughly what each stage costs on a large collection,
 * measured rather than guessed.
 */
const LOAD_STAGES: LoadBands = [
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

let splashLoad: LoadBlock | null = null;

function splashProgress(): HTMLElement {
  splashLoad?.stop();
  splashLoad = loadBlock({ bands: LOAD_STAGES });
  return el('div', { class: 'onboard splash' }, loadingBrand(), splashLoad.node);
}

function endSplashLoad(): void {
  splashBusy = false;
  splashLoad?.stop();
  splashLoad = null;
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
    // The offer, not the name. What this card is for is "you have no patches
    // and here are thirty thousand"; which collection it happens to be is the
    // answer to a question nobody has yet asked, and it is on the About page
    // and in the filter for when they do.
    el('h2', {}, 'Start with a huge library'),
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
    }, loaded ? 'Loaded' : 'Load library')),
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
  if (!autoPipeline() || ctx.store.isAdvancing) {
    render();
    return;
  }
  chainAbort = new AbortController();
  try {
    await ctx.store.advance({
      signal: chainAbort.signal,
      onFail: (pass, err) => {
        lastNote = pass === 'clusters'
          ? `Near-duplicate pass failed: ${err.message}`
          : pass === 'embedding'
            ? `Laying out the map failed: ${err.message}`
            : `Analysis failed: ${err.message}`;
      },
    });
  } finally {
    chainAbort = null;
    render();
  }
}

/** Analysis and de-duplication, as one line of status and at most one button. */
/*
 * Bare, and at the top.
 *
 * This is a status line - one sentence about whether the corpus is ready, and
 * a button on the days it is not. In a card it read as a section of the page
 * with its own subject, competing with the two things on the screen you can
 * actually decide. Out of the card it is what it is: the state of what is
 * already here, above the ways to add more.
 */
function pipelinePanel(): HTMLElement {
  const store = ctx.store;
  const panel = el('div', { class: 'bare pipeline-state' });
  const pending = store.voices.length - store.analysedCount;
  const running = store.isAdvancing || dupeAbort !== null || embedAbort !== null;

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
          chainAbort?.abort();
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
  panel.appendChild(el('p', { class: 'hint', style: { margin: '6px 0 0' } }, bits.join('  ·  ')));

  if (store.staleFeatures > 0) {
    panel.appendChild(el('p', { class: 'warn', style: { margin: '8px 0 0' } },
      `${fmtInt(store.staleFeatures)} voices were analysed by an older build and have to be redone. `,
      'Ratings and favourites are untouched.'));
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
      ? `Restored ${fmtInt(r.ratings)} ratings, ${fmtInt(r.overrides)} category overrides and ${fmtInt(r.pinned)} favourites.`
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
      empty ? el('button', { class: 'btn', onclick: () => restoreInput.click() }, 'Load from backup') : null,
      empty ? restoreInput : null,
      empty ? null : el('button', {
        class: 'btn',
        title: 'Every patch, every rating and every measurement in one file. This is the backup, and the one to move to another machine.',
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
      }, 'Full DX7 curator backup'),
      // Behind the switch: it restores onto a corpus you already have, which
      // is a thing you only want once you know why the full backup is not the
      // answer. The full one is the answer.
      empty ? null : adv(el('button', {
        class: 'btn',
        disabled: store.ratings.size === 0 && !store.voices.some((v) => v.pinned),
        title: 'Ratings, favourites and category overrides only, keyed by patch content. Reapplies to a corpus you already have.',
        onclick: () => {
          const blob = new TextEncoder().encode(store.exportBackup());
          downloadBytes(blob, patchFile(`DX7 ratings ${new Date().toISOString().slice(0, 10)}`, 'json'));
        },
      }, `Ratings only (${fmtInt(store.ratings.size)})`)),
      empty ? null : el('button', {
        class: 'btn',
        title: 'The patches only, deduplicated, as back-to-back 32-voice bulk dumps - which is what every other DX7 tool reads. Not a backup: it carries no ratings.',
        onclick: () => {
          const { bytes, voices } = store.exportDedupedSyx();
          downloadBytes(bytes, patchFile(`DX7 corpus, ${voices} voices`));
        },
      }, 'All .syx, deduped'),
      // Loading is the opposite of the three beside it and was sitting in the
      // middle of them, so it reads as one more thing to save until you have
      // read all four labels. Last, behind a rule.
      empty ? null : el('span', { class: 'bar-sep' }),
      empty ? null : el('button', { class: 'btn', onclick: () => restoreInput.click() }, 'Load from backup'),
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
  /*
   * A patch in the URL takes the screen, before the splash gets it.
   *
   * Only while the library is empty: with a corpus to put it in, a link is
   * handled by opening or importing the patch and this never runs.
   */
  const incoming = peekPendingLink();
  if (incoming) {
    container.appendChild(el('div', { class: 'splash-scrim' }, linkLanding(incoming)));
    return;
  }

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

  // Where the corpus stands, before the ways to change it.
  if (store.voices.length > 0) page.appendChild(pipelinePanel());
  // The same two choices the first screen offers, at the top of the screen you
  // would go to in order to make either of them.
  page.appendChild(choicesRow());
  if (store.voices.length > 0 && store.lastIngest) {
    page.appendChild(el('div', { class: 'panel' }, lastImport(store.lastIngest)));
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
      /*
       * The knobs, without the work.
       *
       * Two of the three things this app remembers are in IndexedDB - the
       * patches and the judgements - and the third is a bag of scalars in
       * localStorage: which axes the map opens on, how wide the sidebars are,
       * what is folded open, the switch itself. It is the one that accumulates
       * a state you cannot find your way out of by clicking, and the one where
       * starting again costs nothing.
       *
       * A reload, because a view reads most of its settings into module
       * variables the first time it is imported: clearing the storage under a
       * running app leaves it working from values that no longer exist.
       */
      el('button', {
        class: 'btn',
        onclick: async () => {
          const ok = await askInPage(ask,
            'Put every setting back to its default - axes, widths, orders, what is folded open? '
            + 'Patches, ratings and favourites are untouched.',
            'Reset settings');
          if (!ok) return;
          clearSettings();
          location.reload();
        },
      }, 'Reset settings'),
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
      if (!ctx.store.isAdvancing && !dupeAbort) render();
    });
    render();
    // Anything left half-done from a previous visit carries on by itself.
    void autoAdvance();
  },
  unmount() {
    unsubscribe?.();
    unsubscribe = null;
    // Leaving the screen does not stop the pipeline: it belongs to the corpus
    // rather than to this view, and finishing it is the whole point.
    // Leaving the screen releases the inputs back to the keyboard handler.
    listening?.();
    listening = null;
  },
};
