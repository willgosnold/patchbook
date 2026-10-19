/** An error patchbook reports as `patchbook: <message>`, exiting 1. */
export class Fail extends Error {}

export class Partway extends Error {
  constructor(readonly stdout: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}
