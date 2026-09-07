/* Where the categoriser currently stands. Run: node test/cats.ts */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSysexFile } from '../src/sysex/parse.ts';
import { unpackVoice, voiceName } from '../src/sysex/voice.ts';
import { renderProbe } from '../src/render/probe.ts';
import { extractAcoustic } from '../src/features/acoustic.ts';
import { extractStructural } from '../src/features/structural.ts';
import { categorize, CATEGORIES, CATEGORY_LABELS, SUBCATEGORIES, subcategoryLabel } from '../src/cluster/category.ts';

const here = dirname(fileURLToPath(import.meta.url));
const rows: Array<{ name: string; u: Uint8Array }> = [];
for (const f of ['ROM1A.syx', 'ROM1B.syx', 'ROM3A.syx', 'ROM3B.syx']) {
  const b = new Uint8Array(readFileSync(join(here, 'fixtures', f)));
  for (const v of parseSysexFile(b, f).voices) {
    const u = unpackVoice(v.packed);
    rows.push({ name: voiceName(u), u });
  }
}

const out = rows.map((r) => {
  const a = extractAcoustic(renderProbe(r.u));
  const s = extractStructural(r.u);
  const c = categorize(a, s, r.name);
  return { ...r, c };
});

console.log(`${out.length} factory voices\n`);
for (const cat of CATEGORIES) {
  const members = out.filter((o) => o.c.best === cat);
  const pct = ((members.length / out.length) * 100).toFixed(0);
  console.log(`${cat.padEnd(9)} ${String(members.length).padStart(3)}  ${pct.padStart(3)}%  ${CATEGORY_LABELS[cat]}`);
  const bySub = new Map<string, string[]>();
  for (const m of members) {
    const k = m.c.sub || '(none)';
    if (!bySub.has(k)) bySub.set(k, []);
    bySub.get(k)!.push(m.name.trim());
  }
  for (const d of SUBCATEGORIES[cat] ?? []) {
    const names = bySub.get(d.id) ?? [];
    if (names.length === 0) continue;
    console.log(`    ${subcategoryLabel(cat, d.id).padEnd(20)} ${String(names.length).padStart(3)}  ${names.slice(0, 6).join(', ')}${names.length > 6 ? ' …' : ''}`);
  }
}

const lowConf = out.filter((o) => o.c.confidence < 0.35).length;
const named = out.filter((o) => o.c.nameMatched).length;
console.log(`\n${lowConf} of ${out.length} were near-ties (confidence < 0.35) and are the ones most worth overriding by hand`);
console.log(`${named} had a name keyword agreeing with the winner`);
