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
  | ({ problem: "conflict" } & InFile & Detail & Refuse)
  | ({ problem: "placeholder" } & (InOutput | InBlock) & Detail)
  | ({ problem: "leak" } & ((InOutput & { line: number }) | InBlock) & { terms: string[] })
  | ({ problem: "missing" } & InBlock & { terms: string[]; upstream: string })
  | {
    problem: "orphan"; file: string; hash: string; occurrence?: Occurrence; kind: string; rules: string; intent: string; upstream: string;
    patched: string; nearest: Nearest[];
  }
  | ({ problem: "check" } & InFile & Detail)
  | ({ problem: "unrecorded" } & InFile & Detail);

/** Which of a file's identical paragraphs an entry patches: the nth from the top, of `of` in all, with `between` the hash of the
 * paragraphs from the identical one before it, or the file's start, to the identical one after it, or the file's end. */
export type Occurrence = { nth: number; of: number; between: string };

/** A candidate for the new home of an orphaned entry. */
export type Nearest = { line: number; hash: string; similarity: number };

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

/** `patchbook check` prints this and exits 10 if any upstream moved. */
export type CheckJson = {
  version: 2;
  moved: boolean;
  /** In the order of the config. */
  upstreams: UpstreamCheck[];
};

export type UpstreamCheck = {
  name: string;
  /** The pinned commit, or null when nothing is pinned. */
  pinned: string | null;
  head: string;
  moved: boolean;
  /** `added`, `changed` or `deleted`, then the path, for each file the move changed. Empty unless `moved`. */
  files: string[];
};

/** What `patchbook sync` writes to `.patchbook/last-sync.json`: for each upstream in the config that a sync has moved, the report of the latest sync that moved it. Entries can come from different runs. After a sync killed before it moves the pin, an entry names a move `upstream.lock` does not hold, until the next `sync` puts the report back. */
export type LastSync = {
  version: 2;
  /** In the order of the config. */
  upstreams: SyncReport[];
};

/** What one sync did to one upstream. */
export type SyncReport = {
  name: string;
  /** The commit pinned before that sync, or null when nothing was pinned before that sync. */
  from: string | null;
  /** The commit that sync pinned, unless that sync was killed before it moved the pin. Compare it with `upstream.lock` to tell. */
  to: string;
  /** The files upstream changed, as in `UpstreamCheck.files`. */
  upstream: string[];
  merged: { change: string; path: string }[];
  /** `count` conflict markers in our copy, or a `detail` when the file is binary. */
  conflicts: ({ change: string; path: string; count: number } | { change: string; path: string; detail: string })[];
  /** Files an edit names that upstream no longer has, with up to three added paths that look like them. */
  gone: { change: string; path: string; maybe: string[] }[];
  /** `change: path` for each `replace` edit whose file changed upstream. */
  replacedUpstreamChanged: string[];
};

/** A pin in `upstream.lock` and in `status --json`. */
export type UpstreamPin = { name: string; commit: string; tree: string };

/** `.patchbook/upstream.lock`, which is committed. Upstreams are sorted by name, by code point. */
export type UpstreamLock = { version: 1; upstreams: UpstreamPin[] };

/** `patchbook status --json` prints this. It exits 1 if `problems` isn't empty. */
export type StatusJson = {
  version: 2;
  /** The pin of each upstream in the config, as `upstream.lock` has them. */
  upstreams: UpstreamPin[];
  /** Edits that apply at the pins. */
  applied: number;
  problems: Problem[];
  /** The document in `last-sync.json`, or null if no sync wrote one. */
  lastSync: LastSync | null;
};
