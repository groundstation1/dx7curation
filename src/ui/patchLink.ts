/*
 * A whole patch in a URL.
 *
 * A DX7 voice is 128 bytes packed, which is small enough to carry in a link
 * rather than referring to one: 171 characters of base64, 219 with the site in
 * front of it. So "listen to this one" does not need an account, an upload, a
 * server or a patch ID that means nothing anywhere else - the sound is in the
 * link, and the link is short enough to paste anywhere.
 *
 * Not compressed. Measured over all 30,365 patches in the shipped library,
 * deflate brings the median to 143 characters and brotli to 136, but the worst
 * case for both is *larger* than the raw 171 - so compressing would trade a
 * fixed, readable, always-the-same-length payload for a variable opaque one, to
 * save about a dozen percent of a URL that is already a fifth of what anything
 * chokes on. Not worth it.
 *
 * The name is in the bytes already - the last ten of the 128 - so a link
 * carries it whether or not the URL says so. The slug in front is decoration:
 * it tells you what you are about to open before you open it, and it is never
 * read back. If somebody edits it, the patch is unchanged and the patch wins;
 * there is exactly one source of truth for what a voice is called.
 */
import { PACKED_SIZE } from '../sysex/voice.ts';

/** The fragment key. `#v=` for voice. */
const KEY = 'v';

/** Slug length: the DX7 name field is ten characters, so this never truncates. */
const SLUG_MAX = 12;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * A readable stand-in for the name, safe in a URL.
 *
 * Patch names are ten characters of whatever the programmer could type, which
 * includes spaces, slashes and the occasional control byte. Anything that is
 * not a letter or a digit becomes a hyphen and runs collapse, so `E.PIANO 1`
 * reads as `e-piano-1`. An empty result is dropped rather than left as a bare
 * separator.
 */
export function slugFor(name: string): string {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug;
}

/** The fragment for one packed voice, including the leading `#`. */
export function encodePatchLink(packed: Uint8Array, name: string): string {
  const slug = slugFor(name);
  const payload = toBase64Url(packed);
  return `#${KEY}=${slug ? `${slug}.` : ''}${payload}`;
}

/** The whole URL, for putting on a clipboard. */
export function patchLinkFor(packed: Uint8Array, name: string): string {
  const base = `${location.origin}${location.pathname}`;
  return base + encodePatchLink(packed, name);
}

/**
 * The packed voice in a fragment, or null if there is not one.
 *
 * Everything about an incoming link is untrusted: it arrives from whoever sent
 * it, through whatever mangled it on the way. A fragment that does not decode,
 * or decodes to the wrong number of bytes, is not an error worth reporting to
 * the person who clicked it - it is simply not a patch, and the app opens
 * normally.
 */
export function decodePatchLink(hash: string): Uint8Array | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith(`${KEY}=`)) return null;
  let payload = raw.slice(KEY.length + 1);
  // The slug is decoration and is thrown away. Splitting on the first dot is
  // safe because base64url has no dot in its alphabet.
  const dot = payload.indexOf('.');
  if (dot >= 0) payload = payload.slice(dot + 1);
  const bytes = fromBase64Url(payload);
  if (!bytes || bytes.length !== PACKED_SIZE) return null;
  return bytes;
}

/*
 * The link this session was opened with, held until something handles it.
 *
 * Read once at startup and then taken, because the fragment is cleared off the
 * address bar as soon as it is read: leaving it there means a reload re-adds
 * the patch, and means the URL goes on advertising a patch long after you have
 * navigated somewhere else entirely.
 */
let pending: Uint8Array | null = null;

/** Read the fragment, remember any patch in it, and clear the address bar. */
export function captureIncomingLink(): boolean {
  pending = decodePatchLink(location.hash);
  if (!pending) return false;
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch {
    // A browser that will not rewrite the address bar still opens the patch.
  }
  return true;
}

/** Whether something is waiting, without consuming it. */
export function hasPendingLink(): boolean {
  return pending !== null;
}

/** A look at the waiting patch, leaving it waiting. */
export function peekPendingLink(): Uint8Array | null {
  return pending;
}

/** Throw the waiting patch away unopened. */
export function dropPendingLink(): void {
  pending = null;
}

/** The waiting patch, handed over exactly once. */
export function takePendingLink(): Uint8Array | null {
  const out = pending;
  pending = null;
  return out;
}
