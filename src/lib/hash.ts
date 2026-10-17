import { encode } from "./text.ts";

export const sha1 = (data: string | Uint8Array) => Bun.SHA1.hash(data, "hex");
export const sha256 = (data: string | Uint8Array) => Bun.SHA256.hash(data, "hex");

/** The id git gives a blob with these bytes. */
export function blobOid(data: Uint8Array): string {
  const head = encode(`blob ${data.length}\0`);
  const all = new Uint8Array(head.length + data.length);
  all.set(head);
  all.set(data, head.length);
  return sha1(all);
}
