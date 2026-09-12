/*
 * The typing keyboard's layout setting has to do something. Run: node test/typing.ts
 *
 * It used to change the picture and nothing else: the notes were looked up by
 * physical position, which is layout-independent and therefore makes the
 * picker decoration. These check that choosing a layout actually moves the
 * notes, and that the picture and the behaviour come from the same place.
 */
import { LAYOUTS, charNotes, keyRows, layoutById } from '../src/audio/typingKeys.ts';

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

console.log('typing keyboard layouts:');

// The white keys of a C major scale, which is what the home row must produce
// whatever is printed on it.
const WHITES = [0, 2, 4, 5, 7, 9, 11, 12, 14];

for (const layout of LAYOUTS) {
  const notes = charNotes(layout);
  const homeNotes = layout.home.slice(0, WHITES.length).map((ch) => notes.get(ch.toLowerCase())?.offset);
  check(`${layout.label}: the home row is the white keys, in order`,
    homeNotes.every((n, k) => n === WHITES[k]), homeNotes.join(','));

  // Every key that plays has exactly one character, or a press would be
  // ambiguous - two keys sounding the same note with no way to tell them apart.
  check(`${layout.label}: no character plays two notes`, notes.size === new Set(notes.keys()).size);
  // Fifteen piano keys plus nine soft mirrors of the white ones.
  check(`${layout.label}: the map covers the whole arrangement`, notes.size === 24, `${notes.size} keys`);

  // The soft row plays the home row, quietly - same notes, flagged soft.
  const softNotes = layout.bottom.slice(0, WHITES.length).map((ch) => notes.get(ch.toLowerCase()));
  check(`${layout.label}: the row below plays the home row softly`,
    softNotes.every((n, k) => n?.offset === WHITES[k] && n.soft === true),
    softNotes.map((n) => (n ? `${n.offset}${n.soft ? 's' : ''}` : '-')).join(','));
}

// The point of the setting: the same character plays a different note under a
// different layout.
const qwerty = charNotes(layoutById('qwerty'));
const neo2 = charNotes(layoutById('neo2'));
check('the same key plays a different note under another layout',
  qwerty.get('a')?.offset !== neo2.get('a')?.offset,
  `qwerty a = ${qwerty.get('a')?.offset}, neo2 a = ${neo2.get('a')?.offset}`);
check('and the leftmost home key is C in both',
  qwerty.get('a')?.offset === 0 && neo2.get('u')?.offset === 0);

// What is drawn has to be what plays, or the legend is a lie.
for (const layout of LAYOUTS) {
  const notes = charNotes(layout);
  const rows = keyRows(layout, 48);
  const drawn = [...rows.black, ...rows.white, ...rows.soft].filter((c) => !c.empty);
  check(`${layout.label}: every drawn key plays what it says`,
    drawn.every((c) => notes.get(c.label.toLowerCase())?.offset === c.note - 48),
    `${drawn.length} keys drawn`);
}

// Every note has two keys - the home row and its twin below - which is what
// makes the second press free to mean something else. Nothing else collides.
for (const layout of LAYOUTS) {
  const notes = charNotes(layout);
  const byNote = new Map<number, string[]>();
  for (const [ch, a] of notes) byNote.set(a.offset, [...(byNote.get(a.offset) ?? []), ch]);
  const pairs = [...byNote.values()].filter((ks) => ks.length > 1);
  check(`${layout.label}: each white note has exactly two keys`,
    pairs.length === WHITES.length && pairs.every((ks) => ks.length === 2),
    `${pairs.length} paired`);
}

console.log(fail === 0 ? '\nall typing checks passed\n' : `\n${fail} check(s) failed\n`);
process.exit(fail === 0 ? 0 : 1);
