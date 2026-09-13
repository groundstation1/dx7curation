/*
 * Patch links: a whole voice in a URL fragment.
 *
 * The round trip has to be exact - a link *is* the patch, not a reference to
 * one, so a single wrong byte is a different sound with nothing to tell you.
 * And the decoder is the one place in this app that reads something a stranger
 * wrote, so most of this is about what it does with rubbish.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice, voiceName, PACKED_SIZE } from '../src/sysex/voice.ts';
import { encodePatchLink, decodePatchLink, slugFor } from '../src/ui/patchLink.ts';

const here = dirname(fileURLToPath(import.meta.url));
const rom = new Uint8Array(readFileSync(join(here, 'fixtures', 'ROM1A.syx')));
const voices = parseSysexFile(rom, 'ROM1A.syx').voices;
const nameOf = (packed: Uint8Array) => voiceName(unpackVoice(packed));

test('every factory voice survives the round trip byte for byte', () => {
  assert.ok(voices.length >= 32, `expected a full bank, got ${voices.length}`);
  for (const v of voices) {
    assert.equal(v.packed.length, PACKED_SIZE);
    const back = decodePatchLink(encodePatchLink(v.packed, nameOf(v.packed)));
    assert.ok(back, `${nameOf(v.packed)} did not decode`);
    assert.deepEqual([...back], [...v.packed], `${nameOf(v.packed)} changed in transit`);
  }
});

test('the link is the length the measurement said it was', () => {
  // 128 bytes of unpadded base64url is exactly 171 characters. The slug and
  // its separator are the only things that vary.
  assert.equal(encodePatchLink(voices[0].packed, '').length, '#v='.length + 171);
});

test('the slug is decoration and the bytes are the truth', () => {
  const link = encodePatchLink(voices[0].packed, 'E.PIANO 1');
  assert.ok(link.includes('e-piano-1.'), link.slice(0, 40));
  // Rewriting the slug by hand must not change which patch it opens.
  const lied = link.replace('e-piano-1.', 'not-a-piano.');
  assert.deepEqual([...decodePatchLink(lied)!], [...voices[0].packed]);
  // And a link with no slug at all is still a link.
  assert.deepEqual([...decodePatchLink(`#v=${link.split('.')[1]}`)!], [...voices[0].packed]);
});

test('names that are not words still make a usable slug', () => {
  assert.equal(slugFor('E.PIANO 1'), 'e-piano-1');
  assert.equal(slugFor('  ***  '), '');
  assert.equal(slugFor('BASS      '), 'bass');
  assert.equal(slugFor('A/B C:D'), 'a-b-c-d');
});

test('rubbish decodes to nothing rather than to a patch', () => {
  const good = encodePatchLink(voices[0].packed, 'X');
  for (const bad of [
    '',
    '#',
    '#v=',
    '#nothing',
    '#v=!!!!not base64!!!!',
    good.slice(0, good.length - 8),   // truncated on the way
    good + 'AAAA',                    // something appended
    `#v=${'A'.repeat(170)}`,          // right alphabet, wrong length
  ]) {
    assert.equal(decodePatchLink(bad), null, `accepted ${JSON.stringify(bad.slice(0, 30))}`);
  }
});

test('the name rides along inside the bytes', () => {
  // Encoded with no slug at all, the name still comes back: it is the last ten
  // of the 128 bytes, which is why the slug never has to be trusted.
  const original = nameOf(voices[3].packed);
  const back = decodePatchLink(encodePatchLink(voices[3].packed, ''))!;
  assert.equal(nameOf(back), original);
});
