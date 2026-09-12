/* Tiny DOM helpers. No framework: the app is five screens and a canvas. */

type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, unknown>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k in node) {
      (node as unknown as Record<string, unknown>)[k] = v;
    } else {
      node.setAttribute(k, String(v));
    }
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/**
 * The title of a screen, and one line saying what it is for.
 *
 * Every view used to open at the same size as everything else in it: a 15px
 * heading over 11px labels over 12px muted paragraphs, with no single element
 * larger or heavier than its neighbours. That flattens the reading order
 * completely - the eye has nowhere to land, so the whole page arrives at once
 * and none of it looks important. One large, solid title per screen fixes more
 * than any amount of spacing does.
 */
export function pageHead(title: string, sub?: string): HTMLElement {
  return el('header', { class: 'page-head' },
    el('h1', { class: 'page-title' }, title),
    sub ? el('p', { class: 'page-sub' }, sub) : null);
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function fmtInt(n: number): string {
  return n.toLocaleString('en-GB');
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/** What the app calls itself, in one place. */
export const APP_NAME = 'DX7 curator';

/**
 * A filename for one patch, saying where it came from.
 *
 * These files end up in other people's editors and other people's folders
 * years later, and a bare `BASS 1.syx` says nothing about how it got there.
 * Anything a filesystem would object to is replaced rather than stripped, so
 * two patches whose names differ only in punctuation stay two files.
 */
export function patchFile(name: string, ext = 'syx'): string {
  const safe = (name || 'voice').trim().replace(/[\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  return `${safe || 'voice'} - via ${APP_NAME}.${ext}`;
}

export function downloadBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
