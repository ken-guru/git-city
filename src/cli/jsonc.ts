/** A config file that is unreadable, malformed or breaks the schema. Reported as a plain error, exit 1. */
export class ConfigError extends Error {}

/**
 * Parses JSON with comments (// and block comments) and trailing commas.
 * It only reads data: nothing in a config file is ever executed.
 */
export function parseJsonc(text: string): unknown {
  const clean = stripJsonc(text);
  try {
    return JSON.parse(clean);
  } catch (e) {
    throw new ConfigError(`invalid JSONC: ${locate(clean, (e as Error).message)}`);
  }
}

/** Blanks out comments and trailing commas, keeping string contents and line breaks. */
function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const stop = close === -1 ? text.length : close + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === ",") {
      // A comma directly before a closing bracket (ignoring whitespace and comments) is dropped.
      const next = nextSignificant(text, i + 1);
      if (next === "}" || next === "]") out += " ";
      else out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Index just past the closing quote of the string starting at `start`. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  return Math.min(i + 1, text.length);
}

function nextSignificant(text: string, from: number): string | undefined {
  let i = from;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) i++;
    else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
    } else return c;
  }
  return undefined;
}

/** Turns a JSON.parse message ("... at position 17") into "line 3, column 5". */
function locate(clean: string, message: string): string {
  const match = /position (\d+)/.exec(message);
  if (!match) return message;
  const at = Number(match[1]);
  const before = clean.slice(0, at);
  const line = before.split("\n").length;
  const column = at - before.lastIndexOf("\n");
  return `line ${line}, column ${column}`;
}
