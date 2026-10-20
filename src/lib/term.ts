const CONTROL = /[\p{Cc}--[\n\t]]/gv;
export const escaped = (text: string): string => text.replace(CONTROL, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export const say = (text: string): void => void process.stdout.write(escaped(text));
export const warn = (text: string): void => void process.stderr.write(escaped(text));
export const verbatim = (data: string | Uint8Array): void => void process.stdout.write(data);
