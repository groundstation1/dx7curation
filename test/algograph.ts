/* Does the reconstructed algorithm graph match the real DX7? Run: node test/algograph.ts */
import { algorithmGraph, carrierLabels } from '../src/engine/algorithmGraph.ts';
import { carrierCount } from '../src/engine/fmcore.ts';

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

// Chains as printed on the DX7 front panel, modulator -> carrier.
const KNOWN: Record<number, { carriers: number[]; chains: string[] }> = {
  1: { carriers: [1, 3], chains: ['6>5>4>3', '2>1'] },
  2: { carriers: [1, 3], chains: ['6>5>4>3', '2>1'] },
  5: { carriers: [1, 3, 5], chains: ['6>5', '4>3', '2>1'] },
  7: { carriers: [1, 3], chains: ['6>5', '2>1', '5>3', '4>3'] },
  16: { carriers: [1], chains: ['6>5>1'] },
  18: { carriers: [1], chains: ['6>5>4', '4>1', '3>1', '2>1'] },
  20: { carriers: [1, 2, 4], chains: ['6>4', '5>4', '3>2', '3>1'] },
  32: { carriers: [1, 2, 3, 4, 5, 6], chains: [] },
};

for (const [algStr, want] of Object.entries(KNOWN)) {
  const alg = Number(algStr) - 1;
  const g = algorithmGraph(alg);
  const got = carrierLabels(alg);
  check(`algorithm ${algStr} carriers`, JSON.stringify(got) === JSON.stringify(want.carriers),
    `got ${got.join(',')} wanted ${want.carriers.join(',')}`);

  const edgeSet = new Set(g.edges.map((e) => `${6 - e.from}>${6 - e.to}`));
  for (const chain of want.chains) {
    const parts = chain.split('>').map(Number);
    for (let i = 0; i + 1 < parts.length; i++) {
      check(`algorithm ${algStr} has ${parts[i]}>${parts[i + 1]}`, edgeSet.has(`${parts[i]}>${parts[i + 1]}`));
    }
  }
}

// Every algorithm must be structurally sane.
for (let alg = 0; alg < 32; alg++) {
  const g = algorithmGraph(alg);
  const ops = new Set(g.nodes.map((n) => n.op));
  if (ops.size !== 6) { console.log(`  FAIL algorithm ${alg + 1} placed ${ops.size} operators`); fail++; }
  const carriers = g.nodes.filter((n) => n.carrier).length;
  if (carriers !== carrierCount(alg)) {
    console.log(`  FAIL algorithm ${alg + 1} carriers ${carriers} vs engine ${carrierCount(alg)}`);
    fail++;
  }
  // An operator may legitimately modulate several targets - algorithm 20 has
  // OP3 feeding both OP2 and OP1 - but never itself, and never the same target
  // twice.
  const seen = new Set<string>();
  for (const e of g.edges) {
    const key = `${e.from}>${e.to}`;
    if (e.from === e.to || seen.has(key)) { console.log(`  FAIL algorithm ${alg + 1} bad edge ${6 - e.from}>${6 - e.to}`); fail++; }
    seen.add(key);
  }
  // Every non-carrier has to end up feeding something, or it would be silent.
  for (const n of g.nodes) {
    if (!n.carrier && !g.edges.some((e) => e.from === n.op)) {
      console.log(`  FAIL algorithm ${alg + 1} operator ${n.label} modulates nothing and is not a carrier`);
      fail++;
    }
  }
  if (g.feedback.length === 0) { console.log(`  FAIL algorithm ${alg + 1} has no feedback operator`); fail++; }
}
check('all 32 algorithms place six operators with the engine’s carrier count', true);

console.log('\nshapes:');
for (let alg = 0; alg < 32; alg++) {
  const g = algorithmGraph(alg);
  const chains = g.edges.map((e) => `${6 - e.from}>${6 - e.to}`).join(' ');
  console.log(`  ${String(alg + 1).padStart(2)}  carriers ${carrierLabels(alg).join(',').padEnd(11)} fb ${g.feedback.map((o) => 6 - o).join('+').padEnd(5)} ${chains}`);
}
console.log(fail === 0 ? '\nall algorithm graph checks passed\n' : `\n${fail} check(s) failed\n`);
process.exit(fail === 0 ? 0 : 1);
