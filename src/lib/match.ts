/** A stretch where two lists differ: old [i1, i2) became new [j1, j2). One side may be empty, never both. */
export type Changed = readonly [i1: number, i2: number, j1: number, j2: number];

/** Where fresh differs from old, in order. The lines that pair are the shared start, then the shared end of what is left,
 * and between them the longest matching whose pairs come earliest, by old line and then new. */
export function lineChanges(old: readonly string[], fresh: readonly string[]): Changed[] {
  const changed: Changed[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs(old, fresh), [old.length, fresh.length] as const]) {
    if (pi > i || pj > j) changed.push([i, pi, j, pj]);
    i = pi + 1;
    j = pj + 1;
  }
  return changed;
}

/**
 * Twice the code points the two texts have in common over the code points of both, to hundredths with a half rounded up; 1 for two empty texts.
 * It rounds the counts, not the ratio: as a double, 0.575 * 100 is 57.49999999999999, so Math.round(r * 100) / 100 gives 0.57.
 */
export function similarity(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const total = x.length + y.length;
  if (total === 0) return 1;
  return Math.floor((400 * lcsLength(x, y) + total) / (2 * total)) / 100;
}

function ends(a: readonly string[], b: readonly string[]): [start: number, end: number] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return [p, s];
}

function intern(a: readonly string[], b: readonly string[]): [Int32Array, Int32Array, number] {
  const ids = new Map<string, number>();
  const id = (e: string): number => {
    let n = ids.get(e);
    if (n === undefined) ids.set(e, (n = ids.size));
    return n;
  };
  return [Int32Array.from(a, id), Int32Array.from(b, id), ids.size];
}

type SparseMask = { wordIndexes: number[]; wordBits: number[] };

function sparseMasks(b: Int32Array, kinds: number): SparseMask[] {
  const out = Array.from({ length: kinds }, (): SparseMask => ({ wordIndexes: [], wordBits: [] }));
  for (let t = 0; t < b.length; t++) {
    const m = out[b[t]!]!;
    if (m.wordIndexes.at(-1) === t >>> 5) m.wordBits[m.wordBits.length - 1]! |= 1 << (t & 31);
    else {
      m.wordIndexes.push(t >>> 5);
      m.wordBits.push(1 << (t & 31));
    }
  }
  return out;
}

/** The next row of the bit-parallel longest common subsequence (Allison and Dix, Hyyrö), out = (v + (v & m)) | (v & ~m)
 * with m the mask of the row's element. Among a row's first t bits, the zeros count the longest common subsequence of
 * the elements stepped so far and the first t elements of the masked list. */
function step(v: Uint32Array, out: Uint32Array, mask: SparseMask): void {
  let carry = 0;
  let k = 0;
  for (let w = 0; w < v.length; w++) {
    const y = v[w]!;
    const m = mask.wordIndexes[k] === w ? mask.wordBits[k++]! : 0;
    // v + (v & m) in 16-bit halves: a sum past 2^31 would be a double, which makes similarity slower.
    const u = y & m;
    const lo = (y & 0xffff) + (u & 0xffff) + carry;
    const hi = (y >>> 16) + (u >>> 16) + (lo >>> 16);
    carry = hi >>> 16;
    out[w] = (hi << 16) | (lo & 0xffff) | (y & ~m);
  }
}

function zeros(v: Uint32Array, t: number): number {
  let ones = 0;
  for (let w = 0; w < t >>> 5; w++) ones += popcount(v[w]!);
  if (t & 31) ones += popcount(v[t >>> 5]! & ((1 << (t & 31)) - 1));
  return t - ones;
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

function lcsLength(a: readonly string[], b: readonly string[]): number {
  const [p, s] = ends(a, b);
  const [x, y, kinds] = intern(a.slice(p, a.length - s), b.slice(p, b.length - s));
  const mask = sparseMasks(y, kinds);
  const v = new Uint32Array((y.length + 31) >>> 5).fill(0xffffffff);
  for (const e of x) step(v, v, mask[e]!);
  return p + s + zeros(v, y.length);
}

function suffixLcs(x: Int32Array, y: Int32Array, kinds: number): (i: number, j: number) => number {
  const mask = sparseMasks(y.toReversed(), kinds);
  const rows = [new Uint32Array((y.length + 31) >>> 5).fill(0xffffffff)];
  for (let i = x.length - 1; i >= 0; i--) {
    const row = new Uint32Array(rows[0]!.length);
    step(rows.at(-1)!, row, mask[x[i]!]!);
    rows.push(row);
  }
  return (i, j) => zeros(rows[x.length - i]!, y.length - j);
}

function pairs(a: readonly string[], b: readonly string[]): [number, number][] {
  const [p, s] = ends(a, b);
  const [x, y, kinds] = intern(a.slice(p, a.length - s), b.slice(p, b.length - s));
  const n = x.length;
  const m = y.length;
  const longest = suffixLcs(x, y, kinds);
  const at = Array.from({ length: kinds }, (): number[] => []);
  for (let j = 0; j < m; j++) at[y[j]!]!.push(j);
  const seen = new Int32Array(kinds);
  const out = Array.from({ length: p }, (_, k): [number, number] => [k, k]);
  let left = longest(0, 0);
  let j = 0;
  for (let i = 0; i < n && left > 0; i++) {
    const e = x[i]!;
    const js = at[e]!;
    let q = seen[e]!;
    while (q < js.length && js[q]! < j) q++;
    seen[e] = q;
    const jj = js[q];
    if (jj !== undefined && 1 + longest(i + 1, jj + 1) === left) {
      out.push([p + i, p + jj]);
      j = jj + 1;
      left--;
    }
  }
  for (let k = 0; k < s; k++) out.push([a.length - s + k, b.length - s + k]);
  return out;
}
