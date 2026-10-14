import { existsSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node } from "web-tree-sitter";

/**
 * Import extraction (SPEC §4, Extract). An extractor turns one file's content into raw specifiers
 * with kind flags, and nothing else: resolving them is the resolver's job.
 *
 * Interface for other languages (#51 Python): implement `ImportExtractor`, give it a `version` that
 * is bumped whenever its output changes, and add it to `EXTRACTORS`. Results are cached per blob ID
 * and extractor version (`ImportCache`), so a version bump invalidates them.
 */

export type ImportKind = "static" | "dynamic" | "type" | "reexport" | "require";

/** One specifier as written in the source. `specifier` is the literal string; nothing is resolved. */
export interface RawImport {
  specifier: string;
  kind: ImportKind;
  /**
   * Python `from a import b`: the name `b` taken from module `a`, one entry per name. Absent for every other
   * import, and for a wildcard import (`from a import *`), which names the module alone.
   */
  member?: string;
}

export interface ImportExtractor {
  /** Stable name, for messages and cache keys. */
  readonly name: string;
  /** Bump when grammar or extraction logic changes its output. Part of the cache key. */
  readonly version: number;
  /** Whether this extractor reads a file at `path`. */
  handles(path: string): boolean;
  /** Raw specifiers in `source`, in source order. Non-literal specifiers are skipped. */
  extract(path: string, source: string): Promise<RawImport[]>;
}

/** Version of the web-tree-sitter TS/JS extractor. Bumped when the grammar source changed to the official packages. */
export const TS_JS_EXTRACTOR_VERSION = 2;

/**
 * The grammar WASM files that `scripts/copy-grammars.mjs` puts in `dist/grammars` (SPEC §12). A built CLI
 * finds them beside its own `dist/cli`; a run from source (tests) finds the same folder in the repository's `dist`.
 */
const GRAMMAR_DIR =
  [new URL("../../grammars/", import.meta.url), new URL("../../../dist/grammars/", import.meta.url)]
    .map((url) => fileURLToPath(url))
    .find((dir) => existsSync(dir)) ?? fileURLToPath(new URL("../../grammars/", import.meta.url));

type GrammarName = "typescript" | "tsx" | "javascript" | "python";

const GRAMMAR_OF_EXTENSION: Record<string, GrammarName> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
};

let parserReady: Promise<void> | undefined;
const languages = new Map<GrammarName, Promise<Language>>();

function ready(): Promise<void> {
  parserReady ??= Parser.init();
  return parserReady;
}

function grammar(name: GrammarName): Promise<Language> {
  let language = languages.get(name);
  if (!language) {
    language = ready().then(() => Language.load(`${GRAMMAR_DIR}tree-sitter-${name}.wasm`));
    languages.set(name, language);
  }
  return language;
}

/** The TS/JS extractor: web-tree-sitter with the TypeScript, TSX and JavaScript grammars. */
export const tsJsExtractor: ImportExtractor = {
  name: "typescript-javascript",
  version: TS_JS_EXTRACTOR_VERSION,
  handles: (path) => extname(path).toLowerCase() in GRAMMAR_OF_EXTENSION,
  async extract(path, source) {
    const name = GRAMMAR_OF_EXTENSION[extname(path).toLowerCase()];
    if (!name) return [];
    const language = await grammar(name);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (!tree) return [];
    const found: RawImport[] = [];
    walk(tree.rootNode, found);
    tree.delete();
    parser.delete();
    return found;
  },
};

/** Version of the Python extractor. Bump when the grammar or the extraction logic changes its output. */
export const PYTHON_EXTRACTOR_VERSION = 1;

/** The Python extractor: web-tree-sitter with the Python grammar. Relative specifiers keep their leading dots. */
export const pythonExtractor: ImportExtractor = {
  name: "python",
  version: PYTHON_EXTRACTOR_VERSION,
  handles: (path) => extname(path).toLowerCase() === ".py",
  async extract(_path, source) {
    const language = await grammar("python");
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (!tree) return [];
    const found: RawImport[] = [];
    walkPython(tree.rootNode, found, false);
    tree.delete();
    parser.delete();
    return found;
  },
};

/** Every extractor, in the order they are consulted. */
export const EXTRACTORS: readonly ImportExtractor[] = [tsJsExtractor, pythonExtractor];

/** The extractor that handles `path`, or undefined when no extractor reads it. */
export function extractorFor(path: string): ImportExtractor | undefined {
  return EXTRACTORS.find((extractor) => extractor.handles(path));
}

/** Extracts raw imports from `source` with the extractor for `path`. Unsupported files yield nothing. */
export async function extractImports(path: string, source: string): Promise<RawImport[]> {
  const extractor = extractorFor(path);
  return extractor ? extractor.extract(path, source) : [];
}

/**
 * Per-run cache of extraction results, keyed by blob ID and extractor version. A blob is parsed once,
 * however many commits carry it. `get` only reads `source` on a miss.
 */
export class ImportCache {
  private readonly results = new Map<string, Promise<RawImport[]>>();

  get(blob: string, path: string, source: string | (() => string)): Promise<RawImport[]> {
    const extractor = extractorFor(path);
    if (!extractor) return Promise.resolve([]);
    const key = `${extractor.name}@${extractor.version}:${blob}`;
    let result = this.results.get(key);
    if (!result) {
      const text = typeof source === "function" ? source() : source;
      result = extractor.extract(path, text);
      this.results.set(key, result);
    }
    return result;
  }

  /** Whether `blob` already has a result for `path`'s extractor, so its text need not be read. */
  has(blob: string, path: string): boolean {
    const extractor = extractorFor(path);
    return extractor !== undefined && this.results.has(`${extractor.name}@${extractor.version}:${blob}`);
  }

  get size(): number {
    return this.results.size;
  }
}

function walk(node: Node, out: RawImport[]): void {
  switch (node.type) {
    case "import_statement": {
      const specifier = sourceOf(node);
      // `import x = require("y")` has no source of its own; its require clause is walked below.
      if (specifier !== undefined) {
        out.push({ specifier, kind: hasTypeKeyword(node) ? "type" : "static" });
        return;
      }
      break;
    }
    case "import_require_clause": {
      const specifier = sourceOf(node);
      if (specifier !== undefined) out.push({ specifier, kind: "require" });
      return;
    }
    case "export_statement": {
      const specifier = sourceOf(node);
      if (specifier !== undefined) out.push({ specifier, kind: hasTypeKeyword(node) ? "type" : "reexport" });
      break;
    }
    case "call_expression": {
      const callee = node.childForFieldName("function");
      const first = node.childForFieldName("arguments")?.namedChildren[0];
      if (callee && first?.type === "string") {
        const specifier = stringValue(first);
        if (callee.type === "import" && specifier !== undefined) {
          out.push({ specifier, kind: insideTypeQuery(node) ? "type" : "dynamic" });
        } else if (callee.type === "identifier" && callee.text === "require" && specifier !== undefined) {
          out.push({ specifier, kind: "require" });
        }
      }
      break;
    }
    default:
      break;
  }
  for (const child of node.children) walk(child, out);
}

/** The literal specifier of a node's `source` field, if it is a plain string. */
function sourceOf(node: Node): string | undefined {
  const source = node.childForFieldName("source");
  return source?.type === "string" ? stringValue(source) : undefined;
}

function stringValue(node: Node): string | undefined {
  const fragment = node.namedChildren.find((c) => c.type === "string_fragment");
  const value = fragment ? fragment.text : node.text.slice(1, -1);
  return value === "" ? undefined : value;
}

/** Whether a statement carries the `type` keyword (`import type ...`, `export type ...`). */
function hasTypeKeyword(node: Node): boolean {
  return node.children.some((c) => c.type === "type");
}

/** `typeof import("x")` and other import types sit inside a type query or an import type. */
function insideTypeQuery(node: Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "type_query" || p.type === "import_type") return true;
  }
  return false;
}

/**
 * Python imports. `import a.b` names the module `a.b`. `from a import b, c` gives one entry per name, each with
 * `member`; `from a import *` gives the module alone. Imports under `if TYPE_CHECKING:` are type-only.
 * `importlib.import_module("x")` and `__import__("x")` with a literal absolute name are dynamic.
 */
function walkPython(node: Node, out: RawImport[], typeOnly: boolean): void {
  switch (node.type) {
    case "import_statement": {
      for (const named of node.namedChildren) {
        const name = named.type === "aliased_import" ? named.childForFieldName("name") : named;
        if (name?.type === "dotted_name") out.push({ specifier: compact(name.text), kind: typeOnly ? "type" : "static" });
      }
      return;
    }
    case "import_from_statement": {
      const [module, ...rest] = node.namedChildren;
      if (!module) return;
      const specifier = compact(module.text);
      if (specifier === "__future__") return;
      const kind: ImportKind = typeOnly ? "type" : "static";
      const names = rest.filter((c) => c.type === "dotted_name" || c.type === "aliased_import");
      if (names.length === 0) {
        out.push({ specifier, kind });
        return;
      }
      for (const named of names) {
        const name = named.type === "aliased_import" ? named.childForFieldName("name") : named;
        if (name) out.push({ specifier, member: compact(name.text), kind });
      }
      return;
    }
    case "call": {
      const callee = node.childForFieldName("function");
      const isImportCall =
        (callee?.type === "identifier" && callee.text === "__import__") ||
        (callee?.type === "attribute" && callee.text === "importlib.import_module");
      const first = node.childForFieldName("arguments")?.namedChildren[0];
      if (isImportCall && first?.type === "string") {
        const specifier = pythonStringValue(first);
        if (specifier !== undefined && !specifier.startsWith(".")) out.push({ specifier, kind: "dynamic" });
      }
      break;
    }
    case "if_statement": {
      const typeChecking = isTypeChecking(node.childForFieldName("condition"));
      for (const child of node.children) walkPython(child, out, typeOnly || typeChecking);
      return;
    }
    default:
      break;
  }
  for (const child of node.children) walkPython(child, out, typeOnly);
}

function isTypeChecking(condition: Node | null): boolean {
  if (!condition) return false;
  return condition.type === "identifier"
    ? condition.text === "TYPE_CHECKING"
    : condition.type === "attribute" && condition.text === "typing.TYPE_CHECKING";
}

/** A dotted name or module with its whitespace removed (a parenthesised import can break a line). */
function compact(text: string): string {
  return text.replace(/\s+/g, "");
}

/** The text of a plain Python string literal, or undefined when it is empty or not a literal. */
function pythonStringValue(node: Node): string | undefined {
  const content = node.namedChildren.find((c) => c.type === "string_content");
  return content && content.text !== "" ? content.text : undefined;
}
