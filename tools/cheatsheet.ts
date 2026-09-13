/*
 * Bake the cheat sheet into one file you can keep.
 *
 * `cheatsheet.html` is a page of the dev server: it pulls the stylesheet and
 * the algorithm component off it, which is right while the sheet is being
 * worked on and useless the day you want to print it from a laptop with no
 * checkout. This inlines the lot - styles, the three typeface files, and the
 * thirty-two diagrams - into one file that opens from disk, on any machine,
 * with no network and no server.
 *
 *   node tools/cheatsheet.ts > docs/dx7-cheatsheet.html
 *
 * The algorithms are drawn by the app's own component rather than
 * reimplemented, which is the point: those cannot drift from what the engine
 * actually renders, and regenerating after an engine change is one command.
 * That component draws into the DOM and Node has no DOM - but it only ever
 * calls four methods on one, so it gets four methods.
 *
 * The two figures at the top are not in that category. They are schematics of
 * the envelope stages and of the four scaling curve shapes, drawn by hand the
 * way the manual draws them, and they are only as right as the person who drew
 * them. They say what the controls are called and roughly what they do; they
 * are not plots of the tables.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const esc = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Just enough of an SVG element to be built up and then printed. */
class Node_ {
  readonly tag: string;
  private attrs = new Map<string, string>();
  private children: Node_[] = [];
  private text = '';

  constructor(tag: string) {
    this.tag = tag;
  }

  setAttribute(key: string, value: unknown): void {
    this.attrs.set(key, String(value));
  }

  getAttribute(key: string): string | null {
    return this.attrs.get(key) ?? null;
  }

  appendChild(child: Node_): Node_ {
    this.children.push(child);
    return child;
  }

  set textContent(value: string) {
    this.text = String(value);
    this.children = [];
  }

  get textContent(): string {
    return this.text;
  }

  toString(): string {
    const attrs = [...this.attrs].map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    const inner = this.text ? esc(this.text) : this.children.map((c) => c.toString()).join('');
    return `<${this.tag}${attrs}>${inner}</${this.tag}>`;
  }
}

(globalThis as unknown as { document: unknown }).document = {
  createElementNS: (_ns: string, tag: string) => new Node_(tag),
};

const { algorithmDiagram } = await import('../src/ui/algorithmDiagram.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const font = (p: string) => readFileSync(join(root, p)).toString('base64');

/** Millimetres per viewBox unit; must match the figure in cheatsheet.html. */
const MM_PER_UNIT = 4.35 / 40;

const cells: string[] = [];
for (let alg = 0; alg < 32; alg++) {
  const fig = algorithmDiagram(alg, { box: 40 }) as unknown as Node_;
  const [, , w, h] = (fig.getAttribute('viewBox') ?? '0 0 1 1').split(/\s+/).map(Number);
  fig.setAttribute('width', `${(w * MM_PER_UNIT).toFixed(2)}mm`);
  fig.setAttribute('height', `${(h * MM_PER_UNIT).toFixed(2)}mm`);
  cells.push(`<div class="cell"><div class="n">${alg + 1}</div>${fig}</div>`);
}

/*
 * The stylesheet's own @font-face rules point at /fonts/..., which is a path on
 * a server. Replaced with the bytes, so the sheet carries its typefaces rather
 * than hoping to find them.
 */
const faces = `
@font-face { font-family: 'Space Mono'; font-weight: 400; font-display: block;
  src: url(data:font/woff2;base64,${font('public/fonts/spacemono-400.woff2')}) format('woff2'); }
@font-face { font-family: 'Space Mono'; font-weight: 700; font-display: block;
  src: url(data:font/woff2;base64,${font('public/fonts/spacemono-700.woff2')}) format('woff2'); }
@font-face { font-family: 'Chango'; font-weight: 400; font-display: block;
  src: url(data:font/woff2;base64,${font('public/fonts/chango-latin.woff2')}) format('woff2'); }`;

const styles = read('src/ui/styles.css').replace(/@font-face\s*\{[^}]*\}/g, '');

const out = read('cheatsheet.html')
  .replace('<link rel="stylesheet" href="/src/ui/styles.css">', `<style>${faces}\n${styles}</style>`)
  // The script exists to draw the algorithms. With them baked in it has nothing
  // to do, and left in place it would fail on a file:// open rather than
  // merely do nothing.
  .replace(/<script type="module">[\s\S]*?<\/script>\s*/, '')
  .replace('<div class="algos" id="algos"></div>', `<div class="algos">\n${cells.join('\n')}\n</div>`);

process.stdout.write(out);
