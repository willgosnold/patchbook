// Declared so the dotted form type-checks. `bun build --define` only replaces the dotted form.
declare namespace NodeJS {
  interface ProcessEnv {
    PATCHBOOK_VERSION?: string;
  }
}
