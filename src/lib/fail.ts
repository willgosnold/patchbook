/** An error patchbook reports as `patchbook: <message>`, exiting 1. */
export class Fail extends Error {}

/** A failure after a command saved some of its work. `said` reports that work, and is printed before the failure. */
export class Partway extends Error {
  constructor(readonly said: string, readonly error: unknown) {
    super(error instanceof Error ? error.message : String(error));
  }
}
