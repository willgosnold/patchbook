import { encode } from "./text.ts";

export const sha1 = (data: string | Uint8Array) => Bun.SHA1.hash(data, "hex");
export const sha256 = (data: string | Uint8Array) => Bun.SHA256.hash(data, "hex");

let known = new WeakMap<Uint8Array, string>();

/** Project hooks can change bytes in place, so ids taken before they run don't count after. */
export function forgetBlobOids(): void {
  known = new WeakMap();
}

/** The id git gives a blob with these bytes. */
export function blobOid(data: Uint8Array): string {
  let oid = known.get(data);
  if (oid === undefined) {
    const head = encode(`blob ${data.length}\0`);
    const all = new Uint8Array(head.length + data.length);
    all.set(head);
    all.set(data, head.length);
    oid = sha1(all);
    known.set(data, oid);
  }
  return oid;
}
