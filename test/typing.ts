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
  const homeNotes = layout.home.slice(0, WHITES.length).map((ch) => notes.get(ch.toLowerCase()));
  check(`${layout.label}: the home row is the white keys, in order`,
    homeNotes.every((n, k) => n === WHITES[k]), homeNotes.join(','));

  // Every key that plays has exactly one character, or a press would be
  // ambiguous - two keys sounding the same note with no way to tell them apart.
  check(`${layout.label}: no character plays two notes`, notes.size === new Set(notes.keys()).size);
  check(`${layout.label}: the map covers the whole arrangement`, notes.size === 15, `${notes.size} keys`);
}

// The point of the setting: the same character plays a different note under a
// different layout.
const qwerty = charNotes(layoutById('qwerty'));
const neo2 = charNotes(layoutById('neo2'));
check('the same key plays a different note under another layout',
  qwerty.get('a') !== neo2.get('a'),
  `qwerty a = ${qwerty.get('a')}, neo2 a = ${neo2.get('a')}`);
check('and the leftmost home key is C in both', qwerty.get('a') === 0 && neo2.get('u') === 0);

// What is drawn has to be what plays, or the legend is a lie.
for (const layout of LAYOUTS) {
  const notes = charNotes(layout);
  const rows = keyRows(layout, 48);
  const drawn = [...rows.black, ...rows.white].filter((c) => !c.empty);
  check(`${layout.label}: every drawn key plays what it says`,
    drawn.every((c) => notes.get(c.label.toLowerCase()) === c.note - 48),
    `${drawn.length} keys drawn`);
}

console.log(fail === 0 ? '\nall typing checks passed\n' : `\n${fail} check(s) failed\n`);
process.exit(fail === 0 ? 0 : 1);
