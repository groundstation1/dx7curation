/*
 * Who made the parts this is built out of.
 *
 * Almost nothing here is original work. The patches are thirty years of other
 * people's programming, collected and kept alive by people who did it for
 * nothing; the synthesis is somebody else's engine, reverse-engineered over
 * years; the hardware it sends to exists because somebody decided a small FM
 * synth was worth making again.
 *
 * Ordered by what is owed. The patches come first - they are the thing this
 * app is about and the only part of it that could not be written again - then
 * what it is built on, then the tools it happens to be written with. Licences
 * sit under each entry rather than beside its name: they are a condition of
 * the credit, not the point of it, and as a badge in the heading they were the
 * loudest thing on a page about people.
 */
import { clear, el } from '../dom.ts';
import type { View, ViewContext } from '../app.ts';

let root: HTMLElement;

interface Credit {
  name: string;
  href?: string;
  who?: string;
  what: string;
  licence?: string;
}

/** The patches themselves. */
const SOURCES: Credit[] = [
  {
    name: 'Yamaha DX7 patch library',
    href: 'https://github.com/visualizersdotnl/Yamaha-DX7-patch-library',
    who: 'compiled by visualizersdotnl',
    what: 'The collection shipped with this app, uploaded so it would not die with a hard '
      + 'drive. It appears here as the DX7 curator standard library, because the repository '
      + 'name says nothing about what is in it.',
    licence: 'CC0 1.0 — public domain, which is why it can travel with the app',
  },
  {
    name: 'All the web DX7 patches',
    href: 'https://bobbyblues.recup.ch/yamaha_dx7/dx7_patches.html',
    who: 'Bobby Blues',
    what: 'Tens of thousands of voices gathered from everywhere they were still findable. '
      + 'The reason a tool for cutting forty thousand patches down to a hundred and '
      + 'twenty-eight needed to exist.',
  },
];

/** The ones without which there is no app. */
const PRINCIPALS: Credit[] = [
  {
    name: 'msfa - music-synthesizer-for-android',
    href: 'https://github.com/google/music-synthesizer-for-android',
    who: 'Raph Levien and contributors, Google Inc.',
    what: 'The DX7 engine. Every operator, envelope, LFO and algorithm here is a TypeScript '
      + 'port of its fixed-point C++, kept close enough that the quirks come with it.',
    licence: 'Apache 2.0',
  },
  {
    name: 'Dexed',
    href: 'https://github.com/asb2m10/dexed',
    who: 'Pascal Gauthier and contributors',
    what: 'The plugin that carried that engine forward and corrected it against real '
      + 'hardware. Its detune curve, envelopes and output levels are what this app matches.',
    licence: 'GPL 3.0',
  },
  {
    name: 'M-Vave FM-1',
    href: 'https://www.cuvave.com/',
    who: 'M-Vave / Cuvave',
    what: 'The synth at the end of all this: six-operator FM in a box that takes a DX7 bulk '
      + 'dump over MIDI, which is what every decision here is aimed at filling.',
  },
  {
    name: 'Claude',
    href: 'https://claude.com/claude-code',
    who: 'Anthropic',
    what: 'Wrote most of this, at the keyboard of someone who kept telling it when it was '
      + 'wrong - which was often, and is why the comments explain themselves.',
  },
];

/** Everything else: real, and not the point. */
const TOOLS: Credit[] = [
  {
    name: 'TypeScript',
    href: 'https://www.typescriptlang.org/',
    what: 'The programming language.',
    licence: 'Apache 2.0',
  },
  {
    name: 'Vite',
    href: 'https://vitejs.dev/',
    what: 'The dev server and bundler.',
    licence: 'MIT',
  },
  {
    name: 'Chango',
    href: 'https://fonts.google.com/specimen/Chango',
    who: 'Julieta Ulanovsky',
    what: 'The font the wordmark is set in.',
    licence: 'SIL Open Font Licence',
  },
  {
    name: 'Space Mono',
    href: 'https://fonts.google.com/specimen/Space+Mono',
    who: 'Colophon Foundry',
    what: 'The font everything else is set in.',
    licence: 'SIL Open Font Licence',
  },
];

function creditRow(c: Credit): HTMLElement {
  return el('div', { class: 'credit' },
    el('div', { class: 'credit-head' },
      c.href
        ? el('a', { href: c.href, target: '_blank', rel: 'noreferrer' }, c.name)
        : el('span', {}, c.name),
      c.who ? el('span', { class: 'credit-who' }, c.who) : null,
    ),
    el('p', { class: 'credit-what' }, c.what),
    // Under the sentence, in the quietest type on the page. It has to be here
    // and it does not have to be read first.
    c.licence ? el('div', { class: 'credit-lic' }, c.licence) : null,
  );
}

function render(): void {
  clear(root);
  const page = el('div', { class: 'stack page-narrow about' },
    el('h1', {}, 'About'),
    el('p', { class: 'lede' },
      'A tool for cutting tens of thousands of freely available DX7 patches down to the '
      + 'hundred and twenty-eight worth keeping. Nothing leaves this browser.'),

    /*
     * The one thing on this page that is not a credit.
     *
     * It is here because it is the only other screen the app has that is about
     * the DX7 rather than about your corpus, and because a reference you print
     * once wants to be findable rather than in the way. It opens in its own
     * tab: it is a page of paper pretending to be a web page, and it prints
     * black on white however dark the app is.
     */
    el('div', { class: 'panel sheet-link' },
      el('div', {},
        el('h2', {}, 'DX7 Cheat sheet'),
        el('p', { class: 'note' },
          'For printing out, or for building patches on the move. '
          + 'A little bonus for you :)')),
      el('a', {
        class: 'btn primary',
        href: 'dx7-cheatsheet.html',
        target: '_blank',
        rel: 'noreferrer',
      }, 'Open it')),

    el('div', { class: 'panel' },
      el('h2', {}, 'The patches'),
      el('p', { class: 'note' },
        'Other people’s work, mostly uncredited in the files themselves. Where a collection '
        + 'says how it may be used, that is respected - the set shipped here is the one '
        + 'released into the public domain. Every name and file path a patch arrived under '
        + 'is kept, which is the only provenance most of them have left.'),
      ...SOURCES.map(creditRow)),

    el('div', { class: 'panel' },
      el('h2', {}, 'Built on'),
      el('p', { class: 'note' }, 'Without these there is no app.'),
      ...PRINCIPALS.map(creditRow)),

    el('div', { class: 'panel' },
      el('h2', {}, 'Libraries and fonts'),
      ...TOOLS.map(creditRow)),
  );
  root.appendChild(page);
}

export const view: View = {
  mount(container: HTMLElement, _ctx: ViewContext) {
    root = container;
    render();
  },
};
