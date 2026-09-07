/*
 * Recovering the shape of a DX7 algorithm from the engine's routing flags.
 *
 * The flag table in fm_core describes an algorithm as a little stack machine:
 * each operator reads one of two buses, writes to one of them or to the output,
 * and either replaces what is there or adds to it. That is efficient to render
 * but says nothing directly about which operator modulates which.
 *
 * Running the machine symbolically recovers it. Track which operators currently
 * own each bus; when an operator reads a bus, everything in it is modulating
 * that operator. What falls out is the familiar picture from the front panel:
 * carriers along the bottom, modulators stacked above them.
 *
 * Operator indices here are the sysex order, where 0 is OP6 and 5 is OP1, so
 * the label to show a human is `6 - index`.
 */
import { algorithms, FB_IN, FB_OUT, OUT_BUS_ADD } from './fmcore.ts';

export interface AlgorithmNode {
  /** Operator index, 0 = OP6. */
  op: number;
  /** The number printed on the front panel. */
  label: number;
  carrier: boolean;
  /** 0 for carriers, 1 for their modulators, and so on. */
  depth: number;
  /** Column position, in units of one operator box. */
  column: number;
}

export interface AlgorithmGraph {
  algorithm: number;
  nodes: AlgorithmNode[];
  /** Modulator to the operator it modulates. */
  edges: Array<{ from: number; to: number }>;
  /** Operators inside the feedback loop, deepest first. */
  feedback: number[];
  /** Total width in operator-box units. */
  width: number;
  /** Number of stacked rows. */
  height: number;
}

export function algorithmGraph(algorithm: number): AlgorithmGraph {
  const flags = algorithms[algorithm & 31];
  const busOwners: number[][] = [[], [], []];
  // An operator can modulate more than one target: when two operators read the
  // same bus without either of them replacing it, whatever is in that bus feeds
  // both. Algorithm 20 is the clearest case - OP3 modulates OP2 and OP1.
  const targets: number[][] = Array.from({ length: 6 }, () => []);
  const carriers: number[] = [];
  const feedback: number[] = [];

  for (let op = 0; op < 6; op++) {
    const f = flags[op];
    const inbus = (f >> 4) & 3;
    const outbus = f & 3;
    const add = (f & OUT_BUS_ADD) !== 0;

    if (f & FB_OUT || f & FB_IN) feedback.push(op);

    if (inbus !== 0) {
      for (const m of busOwners[inbus]) targets[m].push(op);
    }
    if (outbus === 0) {
      carriers.push(op);
    } else {
      if (!add) busOwners[outbus] = [];
      busOwners[outbus].push(op);
    }
  }

  const edges: Array<{ from: number; to: number }> = [];
  for (let op = 0; op < 6; op++) {
    for (const to of targets[op]) edges.push({ from: op, to });
  }

  // ---- layout ----
  //
  // Layered rather than tree-shaped. An operator can feed several carriers -
  // algorithm 24 has OP6 modulating OP5, OP4 and OP3 - and treating the graph
  // as a tree parked such an operator above the first of its targets with long
  // lines trailing off to the others. Placing each operator at the average
  // column of everything it feeds puts it where the front panel puts it:
  // centred over its targets.
  const depth = new Int8Array(6).fill(-1);
  const depthOf = (op: number): number => {
    if (depth[op] >= 0) return depth[op];
    if (targets[op].length === 0) {
      depth[op] = 0;
      return 0;
    }
    let d = 0;
    // Guard against a cycle: feedback is drawn separately, never followed here.
    depth[op] = 0;
    for (const t of targets[op]) d = Math.max(d, depthOf(t) + 1);
    depth[op] = d;
    return d;
  };
  for (let op = 0; op < 6; op++) depthOf(op);

  let height = 1;
  for (let op = 0; op < 6; op++) height = Math.max(height, depth[op] + 1);

  const column = new Float64Array(6).fill(-1);
  carriers.forEach((op, i) => {
    column[op] = i;
  });

  const modulators: number[][] = Array.from({ length: 6 }, () => []);
  for (let op = 0; op < 6; op++) {
    for (const t of targets[op]) modulators[t].push(op);
  }

  /** Place a layer at the average of some related set, then un-overlap it. */
  const relax = (d: number, related: (op: number) => number[]) => {
    const layer: Array<{ op: number; want: number }> = [];
    for (let op = 0; op < 6; op++) {
      if (depth[op] !== d) continue;
      const rel = related(op).filter((r) => column[r] >= 0);
      const want = rel.length
        ? rel.reduce((sum, r) => sum + column[r], 0) / rel.length
        : column[op] >= 0 ? column[op] : 0;
      layer.push({ op, want });
    }
    layer.sort((a, b) => a.want - b.want);
    let last = -Infinity;
    for (const item of layer) {
      const place = Math.max(item.want, last + 1);
      column[item.op] = place;
      last = place;
    }
  };

  // Upwards, so every modulator sits over what it feeds.
  for (let d = 1; d < height; d++) relax(d, (op) => targets[op]);

  // Then one downward pass, but only for operators fed by more than one
  // modulator - those genuinely want centring under their stack. Applying it to
  // everything made the two passes fight: in algorithm 24 three carriers share
  // a single modulator, so all three asked for its column, got spread apart to
  // avoid overlapping, and dragged the modulator rightwards on the next pass.
  // Repeat that and the whole diagram walks off to the right.
  for (let d = 0; d < height; d++) {
    relax(d, (op) => (modulators[op].length > 1 ? modulators[op] : []));
  }

  // Pull everything back so the leftmost operator sits at column zero.
  let minCol = Infinity;
  for (let op = 0; op < 6; op++) minCol = Math.min(minCol, column[op]);
  if (Number.isFinite(minCol) && minCol !== 0) {
    for (let op = 0; op < 6; op++) column[op] -= minCol;
  }

  const nodes: AlgorithmNode[] = [];
  let widest = 0;
  for (let op = 0; op < 6; op++) {
    nodes.push({ op, label: 6 - op, carrier: depth[op] === 0, depth: depth[op], column: column[op] });
    widest = Math.max(widest, column[op]);
  }

  return {
    algorithm: algorithm & 31,
    nodes,
    edges,
    feedback: feedback.sort((a, b) => depth[b] - depth[a]),
    width: widest + 1,
    height,
  };
}

/** Carriers of an algorithm, as front-panel operator numbers. */
export function carrierLabels(algorithm: number): number[] {
  return algorithmGraph(algorithm).nodes.filter((n) => n.carrier).map((n) => n.label).sort((a, b) => a - b);
}
