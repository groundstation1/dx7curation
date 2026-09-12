/*
 * The long passes have to hand the thread back. Run: node test/pacing.ts
 *
 * Not a test of the ordering - that is unchanged - but of the promise the
 * progress bar makes. A quadratic loop run to completion freezes the tab, and
 * the symptom is indistinguishable from a crash, so "it yields" is the
 * behaviour worth pinning down.
 */
import { Store } from '../src/ui/state.ts';

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

console.log('pacing of the long passes:');

// A corpus-shaped set: points scattered over a plane, no database in sight.
// Large enough that the pass takes long enough to have to yield - at six
// thousand it finishes inside four slices, which proves nothing either way.
const N = 14000;
const store = new Store();
const proj = new Float32Array(N * 2);
let seed = 7;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
for (let i = 0; i < N; i++) {
  proj[i * 2] = rnd() * 100;
  proj[i * 2 + 1] = rnd() * 100;
}
store.projection = proj;
const indices = Array.from({ length: N }, (_, i) => i);

let slices = 0;
let longestBlock = 0;
let last = performance.now();
const t0 = performance.now();
const order = await store.coverageOrder(indices, (done, total) => {
  slices++;
  longestBlock = Math.max(longestBlock, performance.now() - last);
  if (done > total) fail++;
  last = performance.now();
});
const elapsed = performance.now() - t0;

check('every voice comes back exactly once',
  order.length === N && new Set(order).size === N, `${order.length} of ${N}`);
check('it yielded rather than running straight through', slices >= 4, `${slices} slices`);
// The contract: never more than about one slice plus the cost of the single
// longest pick. A frame is 16 ms, so this stays inside "the page still moves".
check('no slice held the thread for long', longestBlock < 60,
  `longest ${longestBlock.toFixed(0)} ms over ${elapsed.toFixed(0)} ms total`);

// The first pick is the most central, and the second is the furthest from it:
// the property the whole ordering exists for.
const px = (i: number) => proj[i * 2];
const py = (i: number) => proj[i * 2 + 1];
const d2 = (a: number, b: number) => (px(a) - px(b)) ** 2 + (py(a) - py(b)) ** 2;
let furthest = order[1];
for (const i of indices) if (i !== order[0] && d2(order[0], i) > d2(order[0], furthest)) furthest = i;
check('the second pick is the furthest from the first', order[1] === furthest);

// Without a callback it must still work, synchronously enough to be usable.
const plain = await store.coverageOrder(indices.slice(0, 400));
check('it still works with nothing watching', plain.length === 400);

console.log(fail === 0 ? '\nall pacing checks passed\n' : `\n${fail} check(s) failed\n`);
process.exit(fail === 0 ? 0 : 1);
