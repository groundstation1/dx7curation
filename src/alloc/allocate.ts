/*
 * Deciding which 128 voices get in.
 *
 * Pinned voices are seated first and unconditionally. Then each category gets a
 * floor, so a minority category survives even if the user rated it lukewarm,
 * and a ceiling, so electric pianos cannot eat the whole bank. What is left
 * over is split between categories in proportion to how highly the user rated
 * their best patches - so taste still steers the balance, inside the bounds.
 *
 * Within a category, filling is purely by rating rank. There is deliberately no
 * diversity penalty: two near-identical 5s both get in and both consume slots,
 * because the user already had their chance to collapse them in the face-off.
 */
import { CATEGORIES, type Category } from '../cluster/category.ts';

export interface Candidate {
  id: number;
  category: Category;
  /**
   * User rating, 1-5, plus up to half a star of ranking offset.
   *
   * Fractional because the ranking pass orders within a band; the offset is
   * capped below half a star so `Math.round` always recovers the star the user
   * actually gave. Every threshold here rounds before comparing, so "five or
   * better" still admits a five that lost every comparison it was in.
   */
  rating: number;
  pinned: boolean;
  /** Tie-break within a rating, higher first. Defaults to 0. */
  tieBreak?: number;
}

export type CategoryCounts = Record<Category, number>;

export interface AllocationOptions {
  total?: number;
  floors?: Partial<CategoryCounts>;
  ceilings?: Partial<CategoryCounts>;
  /** How many top-rated candidates per category feed the category's weight. */
  topN?: number;
  /** Minimum rating that can be seated on merit. */
  minRating?: number;
  /**
   * Top up any slots the rating-based fill leaves empty. 128 is a lot to fill
   * from a first pass, and an empty slot is worth less than a 3 you can replace
   * later, so the remainder is taken by rating rank, ignoring the floors (they
   * have already been honoured) and preferring categories still under ceiling.
   */
  backfill?: boolean;
  /** Nothing below this is ever seated, even as backfill. */
  backfillMinRating?: number;
}

export interface CategoryOutcome {
  category: Category;
  /** Candidates available at or above minRating. */
  available: number;
  pinned: number;
  floor: number;
  ceiling: number;
  /** Mean of the category's top-N ratings; the weight used for free slots. */
  weight: number;
  allocated: number;
  filled: number;
}

export type SelectedCandidate = Candidate & {
  /** Seated to fill a gap rather than on merit. */
  backfilled: boolean;
};

export interface AllocationResult {
  selected: SelectedCandidate[];
  byCategory: CategoryOutcome[];
  /** Seated on merit, at or above minRating. */
  onMerit: number;
  /** Seated only because slots would otherwise be empty. */
  backfilled: number;
  /** Lowest rating that made it in, or 0 when nothing did. */
  lowestRating: number;
  /** Slots still empty after backfilling; these become placeholders. */
  unfilled: number;
  warnings: string[];
}

export const DEFAULT_FLOORS: CategoryCounts = {
  keys: 12,
  bells: 8,
  plucked: 8,
  bass: 8,
  brass: 8,
  lead: 6,
  organ: 6,
  strings: 12,
  abstract: 6,
};

export const DEFAULT_CEILINGS: CategoryCounts = {
  keys: 30,
  bells: 22,
  plucked: 22,
  bass: 18,
  brass: 22,
  lead: 18,
  organ: 16,
  strings: 30,
  abstract: 18,
};

function rank(a: Candidate, b: Candidate): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (b.rating !== a.rating) return b.rating - a.rating;
  return (b.tieBreak ?? 0) - (a.tieBreak ?? 0);
}

export function allocate(candidates: Candidate[], opts: AllocationOptions = {}): AllocationResult {
  const total = opts.total ?? 128;
  const topN = opts.topN ?? 12;
  const minRating = opts.minRating ?? 4;
  const doBackfill = opts.backfill ?? true;
  const backfillMinRating = opts.backfillMinRating ?? 1;
  const floors = { ...DEFAULT_FLOORS, ...opts.floors };
  const ceilings = { ...DEFAULT_CEILINGS, ...opts.ceilings };
  const warnings: string[] = [];

  const pool = new Map<Category, Candidate[]>();
  for (const c of CATEGORIES) pool.set(c, []);
  for (const cand of candidates) {
    if (!cand.pinned && Math.round(cand.rating) < minRating) continue;
    pool.get(cand.category)?.push(cand);
  }
  for (const c of CATEGORIES) pool.get(c)!.sort(rank);

  const pinnedCount = new Map<Category, number>();
  let pinnedTotal = 0;
  for (const c of CATEGORIES) {
    const n = pool.get(c)!.filter((x) => x.pinned).length;
    pinnedCount.set(c, n);
    pinnedTotal += n;
  }
  if (pinnedTotal > total) {
    warnings.push(`${pinnedTotal} favourites exceed the ${total} available slots; the lowest-rated were dropped`);
  }

  // ---- weights from the top of each category ----
  const weight = new Map<Category, number>();
  for (const c of CATEGORIES) {
    const top = pool.get(c)!.slice(0, topN);
    weight.set(c, top.length ? top.reduce((s, x) => s + x.rating, 0) / top.length : 0);
  }

  // ---- capacity per category ----
  const capacity = new Map<Category, number>();
  for (const c of CATEGORIES) {
    capacity.set(c, Math.min(ceilings[c], pool.get(c)!.length));
  }

  // ---- seat pinned, then floors, then free slots ----
  const allocated = new Map<Category, number>();
  let used = 0;
  for (const c of CATEGORIES) {
    const n = Math.min(pinnedCount.get(c)!, capacity.get(c)!, total - used);
    allocated.set(c, n);
    used += n;
  }
  if (used < pinnedTotal) {
    warnings.push('some favourites did not fit inside their category ceiling');
  }

  const desiredFloor = new Map<Category, number>();
  let floorSum = 0;
  for (const c of CATEGORIES) {
    const want = Math.max(0, Math.min(floors[c], capacity.get(c)!) - allocated.get(c)!);
    desiredFloor.set(c, want);
    floorSum += want;
  }
  if (floorSum > total - used) {
    const scale = (total - used) / Math.max(1, floorSum);
    warnings.push(`category floors total ${floorSum + used}, more than ${total} slots; floors scaled by ${scale.toFixed(2)}`);
    for (const c of CATEGORIES) desiredFloor.set(c, Math.floor(desiredFloor.get(c)! * scale));
  }
  for (const c of CATEGORIES) {
    const n = Math.min(desiredFloor.get(c)!, total - used);
    allocated.set(c, allocated.get(c)! + n);
    used += n;
  }

  // Free slots, proportional to category weight, largest-remainder with caps.
  let free = total - used;
  while (free > 0) {
    const open = CATEGORIES.filter((c) => allocated.get(c)! < capacity.get(c)! && weight.get(c)! > 0);
    if (open.length === 0) break;
    const totalWeight = open.reduce((s, c) => s + weight.get(c)!, 0);
    const share = new Map<Category, number>();
    let handed = 0;
    for (const c of open) {
      const want = Math.floor((free * weight.get(c)!) / totalWeight);
      const give = Math.min(want, capacity.get(c)! - allocated.get(c)!);
      share.set(c, give);
      handed += give;
    }
    // Hand out the rounding remainder to the highest-weight categories that
    // still have room, so a single pass always makes progress.
    let remainder = free - handed;
    const byWeight = [...open].sort((a, b) => weight.get(b)! - weight.get(a)!);
    for (const c of byWeight) {
      if (remainder <= 0) break;
      const room = capacity.get(c)! - allocated.get(c)! - (share.get(c) ?? 0);
      if (room <= 0) continue;
      const give = Math.min(room, remainder);
      share.set(c, (share.get(c) ?? 0) + give);
      remainder -= give;
    }
    let progressed = false;
    for (const c of open) {
      const give = share.get(c) ?? 0;
      if (give > 0) progressed = true;
      allocated.set(c, allocated.get(c)! + give);
      free -= give;
    }
    if (!progressed) break;
  }

  // ---- fill ----
  const selected: SelectedCandidate[] = [];
  const byCategory: CategoryOutcome[] = [];
  const seated = new Set<number>();
  for (const c of CATEGORIES) {
    const take = pool.get(c)!.slice(0, allocated.get(c)!);
    for (const t of take) {
      selected.push({ ...t, backfilled: false });
      seated.add(t.id);
    }
    byCategory.push({
      category: c,
      available: pool.get(c)!.length,
      pinned: pinnedCount.get(c)!,
      floor: floors[c],
      ceiling: ceilings[c],
      weight: weight.get(c)!,
      allocated: allocated.get(c)!,
      filled: take.length,
    });
  }

  const onMerit = selected.length;

  // ---- backfill ----
  let backfilled = 0;
  if (doBackfill && selected.length < total) {
    const perCategory = new Map<Category, number>();
    for (const s of selected) perCategory.set(s.category, (perCategory.get(s.category) ?? 0) + 1);

    const leftovers = candidates
      .filter((c) => !seated.has(c.id) && Math.round(c.rating) >= backfillMinRating)
      .sort(rank);

    // Two passes: first respecting ceilings, then ignoring them, so a lopsided
    // corpus still produces a full bank rather than a half-empty one.
    for (const respectCeilings of [true, false]) {
      for (const cand of leftovers) {
        if (selected.length >= total) break;
        if (seated.has(cand.id)) continue;
        const used = perCategory.get(cand.category) ?? 0;
        if (respectCeilings && used >= ceilings[cand.category]) continue;
        selected.push({ ...cand, backfilled: true });
        seated.add(cand.id);
        perCategory.set(cand.category, used + 1);
        backfilled++;
      }
      if (selected.length >= total) break;
    }

    for (const o of byCategory) o.filled = perCategory.get(o.category) ?? o.filled;
  }

  let lowestRating = 0;
  for (const s of selected) {
    const star = Math.round(s.rating);
    if (lowestRating === 0 || star < lowestRating) lowestRating = star;
  }

  const unfilled = total - selected.length;
  if (backfilled > 0) {
    warnings.push(`${backfilled} slot${backfilled === 1 ? '' : 's'} filled below ${minRating} stars, down to ${lowestRating}.`);
  }
  if (unfilled > 0) {
    warnings.push(`${unfilled} slot${unfilled === 1 ? '' : 's'} left empty.`);
  }

  return { selected, byCategory, onMerit, backfilled, lowestRating, unfilled, warnings };
}
