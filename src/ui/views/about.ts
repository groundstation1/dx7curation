/*
 * Who made the parts this is built out of.
 *
 * Almost nothing here is original work. The synthesis is somebody else's
 * engine, carefully reverse-engineered over years; the patches are thirty
 * years of other people's programming, collected and kept alive by people who
 * did it for nothing; the hardware it sends to exists because somebody decided
 * a small FM synth was worth making again. A credits page is the least of what
 * is owed, and it is grouped so the distinction is visible: the things this
 * would not exist without, then the tools it happens to be written with.
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

/** The ones without which there is no app. */
const PRINCIPALS: Credit[] = [
  {
    name: 'msfa - music-synthesizer-for-android',
    href: 'https://github.com/google/music-synthesizer-for-android',
    who: 'Raph Levien and contributors, Google Inc.',
    what: 'The DX7 engine. Every operator, envelope, LFO and algorithm in this app is a '
      + 'TypeScript port of msfa’s fixed-point C++ - dx7note, env, fm_core, fm_op_kernel, '
      + 'lfo and pitchenv - kept close enough to the original that its quirks come with it.',
    licence: 'Apache 2.0',
  },
  {
    name: 'Dexed',
    href: 'https://github.com/asb2m10/dexed',
    who: 'Pascal Gauthier and contributors',
    what: 'The DX7 plugin that carried msfa’s engine forward and corrected it against '
      + 'real hardware. Its detune curve, its envelope behaviour and its output levels are '
      + 'what this app matches, and its sysex handling is the reference for what a DX7 file '
      + 'can contain.',
    licence: 'GPL 3.0',
  },
  {
    name: 'Yamaha DX7 patch library',
    href: 'https://github.com/visualizersdotnl/Yamaha-DX7-patch-library',
    who: 'compiled by visualizersdotnl',
    what: 'The collection this app ships with, uploaded so it would not die with a hard '
      + 'drive. Released into the public domain, which is why it can travel with the app '
      + 'rather than being something you are asked to go and find.',
    licence: 'CC0 1.0',
  },
  {
    name: 'All the web DX7 patches',
    href: 'https://bobbyblues.recup.ch/yamaha_dx7/dx7_patches.html',
    who: 'Bobby Blues',
    what: 'The large archive this app was built to get through: tens of thousands of voices '
      + 'gathered from everywhere they were still findable. The reason a tool for reducing '
      + 'forty thousand patches to a hundred and twenty-eight needed to exist at all.',
  },
  {
    name: 'M-Vave FM-1',
    href: 'https://www.cuvave.com/',
    who: 'M-Vave / Cuvave',
    what: 'The synth at the end of all this. Six-operator FM in a box that takes a DX7 bulk '
      + 'dump over MIDI, which is what every decision here is ultimately aimed at filling.',
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
  { name: 'TypeScript', href: 'https://www.typescriptlang.org/', what: 'The language.', licence: 'Apache 2.0' },
  { name: 'Vite', href: 'https://vitejs.dev/', what: 'Dev server and bundler.', licence: 'MIT' },
  {
    name: 'Chango',
    href: 'https://fonts.google.com/specimen/Chango',
    who: 'Julieta Ulanovsky',
    what: 'The wordmark.',
    licence: 'SIL Open Font Licence',
  },
  {
    name: 'Space Mono',
    href: 'https://fonts.google.com/specimen/Space+Mono',
    who: 'Colophon Foundry',
    what: 'Everything else.',
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
      c.licence ? el('span', { class: 'credit-lic' }, c.licence) : null,
    ),
    el('p', { class: 'credit-what' }, c.what),
  );
}

function render(): void {
  clear(root);
  const page = el('div', { class: 'stack page-narrow about' },
    el('h1', {}, 'About'),
    el('p', { class: 'lede' },
      'A tool for turning tens of thousands of freely available DX7 patches into a hundred '
      + 'and twenty-eight worth keeping. Everything happens on this machine: the patches, '
      + 'the measurements and your ratings never leave the browser.'),

    el('div', { class: 'panel' },
      el('h2', {}, 'Built on'),
      el('p', { class: 'note' }, 'Without these there is no app.'),
      ...PRINCIPALS.map(creditRow)),

    el('div', { class: 'panel' },
      el('h2', {}, 'Also used'),
      el('p', { class: 'note' }, 'Tools and typefaces.'),
      ...TOOLS.map(creditRow)),

    el('div', { class: 'panel' },
      el('h2', {}, 'On the patches'),
      el('p', { class: 'credit-what' },
        'Patch data is other people’s work - thirty years of it, by programmers who mostly '
        + 'are not credited anywhere in the files themselves. Where a collection says how it '
        + 'may be used, that is respected: the set shipped with this app is the one released '
        + 'into the public domain. Everything you add yourself stays on your machine and is '
        + 'never sent anywhere.'),
      el('p', { class: 'credit-what' },
        'The app keeps every name and every file path a patch arrived under, which is the '
        + 'only provenance most of them have left.')),
  );
  root.appendChild(page);
}

export const view: View = {
  mount(container: HTMLElement, _ctx: ViewContext) {
    root = container;
    render();
  },
};
