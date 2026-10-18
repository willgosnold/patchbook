// The types a repo's `.patchbook/hooks.ts` sees. Types only, so it imports nothing and ships as one `.d.ts`.

type InFile = { file: string };
export type InEdit = { file: string; edit: string };
export type InChange = { file: string; change: string };
export type InOutput = { file: string; output: string };
export type InBlock = { file: string; output: string; line: number; hash: string };
type Detail = { detail: string };
/** Marks a problem the pre-commit hook refuses the commit for, where any other only skips the build with a warning. */
type Refuse = { refuse: true };

/** What status reports, keyed on `problem`. Each kind has exactly the fields it's built with, in order. */
export type Problem =
  | ({ problem: "invalid" } & (InFile | InEdit | InChange | InOutput | InBlock) & Detail)
  | ({ problem: "invalid" } & (InFile | InEdit | InChange) & Detail & Refuse)
  | ({ problem: "gone" } & (InEdit | InChange) & Detail)
  | ({ problem: "stale" } & InChange & Detail)
  | ({ problem: "conflict" } & (InFile | InChange) & Detail)
  | ({ problem: "placeholder" } & (InOutput | InBlock) & Detail)
  | ({ problem: "leak" } & ((InOutput & { line: number }) | InBlock) & { terms: string[] })
  | ({ problem: "missing" } & InBlock & { terms: string[]; upstream: string })
  | {
    problem: "orphan"; file: string; hash: string; kind: string; rules: string; intent: string; upstream: string;
    patched: string; nearest: Nearest[];
  }
  | ({ problem: "check" } & InFile & Detail);

/** A candidate for the new home of an orphaned entry. */
export type Nearest = { line: number; hash: string; similarity: { readonly value: number } };

/** What a repo's `.patchbook/hooks.ts` can export. Patchbook calls each by name. */
export interface Hooks {
  /** The value of `{{kind:name}}`, or null to look it up in the config's placeholder source. */
  placeholder?(kind: string, name: string): string | null | undefined;
  /** Text in a block that needs an entry, beyond what the config's `[[check]]` patterns find. */
  blockTerms?(path: string, block: string, outputs: ReadonlySet<string>): Iterable<string>;
  /** Change the output, path by path, before it's checked and written. */
  finish?(out: Map<string, { data: Uint8Array; mode: number }>): void;
  /** Problems with the output that the config can't express. */
  check?(outputs: ReadonlyMap<string, Uint8Array>): Problem[];
}
