/** An error patchbook reports as `patchbook: <message>`, exiting 1. */
export class Fail extends Error {}

/** A Fail that changed nothing, so a caller that wrote its config ahead of the check can put it back. */
export class Refused extends Fail {}
