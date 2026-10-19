// A line-for-line port of CPython's difflib.SequenceMatcher (without isjunk).
// Strings are compared by code point, as Python iterates them, and elements are keyed in a Map, so
// "constructor" and "__proto__" are ordinary elements.

export type Tag = "replace" | "delete" | "insert" | "equal";
export type Opcode = [tag: Tag, i1: number, i2: number, j1: number, j2: number];
type Match = [i: number, j: number, size: number];

export class SequenceMatcher<T> {
  private readonly a: T[];
  private readonly b: T[];
  private readonly b2j = new Map<T, number[]>();
  private matchingBlocks: Match[] | null = null;
  private opcodes: Opcode[] | null = null;

  constructor(a: Iterable<T>, b: Iterable<T>, autojunk = true) {
    this.a = Array.from(a);
    this.b = Array.from(b);
    const { b: seq, b2j } = this;
    for (const [i, elt] of seq.entries()) {
      const indices = b2j.get(elt);
      if (indices) indices.push(i);
      else b2j.set(elt, [i]);
    }
    if (autojunk && seq.length >= 200) {
      const ntest = Math.floor(seq.length / 100) + 1;
      for (const [elt, indices] of b2j) if (indices.length > ntest) b2j.delete(elt);
    }
  }

  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Match {
    const { a, b, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // Popular elements aren't in b2j, so extend the match over equal neighbours. Without isjunk
    // nothing is junk, and CPython's two junk-extension loops never run.
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  }

  getMatchingBlocks(): Match[] {
    if (this.matchingBlocks) return this.matchingBlocks;
    const la = this.a.length;
    const lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const blocks: Match[] = [];
    for (let next = queue.pop(); next; next = queue.pop()) {
      const [alo, ahi, blo, bhi] = next;
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = x;
      if (k) {
        blocks.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const nonAdjacent: Match[] = [];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) nonAdjacent.push([i1, j1, k1]);
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1) nonAdjacent.push([i1, j1, k1]);
    nonAdjacent.push([la, lb, 0]);
    return (this.matchingBlocks = nonAdjacent);
  }

  getOpcodes(): Opcode[] {
    if (this.opcodes) return this.opcodes;
    let i = 0;
    let j = 0;
    const answer: Opcode[] = [];
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      const tag: Tag | "" = i < ai && j < bj ? "replace" : i < ai ? "delete" : j < bj ? "insert" : "";
      if (tag) answer.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size) answer.push(["equal", ai, i, bj, j]);
    }
    return (this.opcodes = answer);
  }

  ratio(): number {
    const matches = this.getMatchingBlocks().reduce((sum, m) => sum + m[2], 0);
    const length = this.a.length + this.b.length;
    return length ? (2.0 * matches) / length : 1.0;
  }
}
