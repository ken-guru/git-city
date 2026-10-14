import { createRequire } from "node:module";
import { extname } from "node:path";
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

/** Version of the web-tree-sitter TS/JS extractor. */
export const TS_JS_EXTRACTOR_VERSION = 1;

const require = createRequire(import.meta.url);
/** Directory holding the grammar WASM files shipped by @vscode/tree-sitter-wasm. */
const GRAMMAR_DIR = require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter.js").replace(/tree-sitter\.js$/, "");

type GrammarName = "typescript" | "tsx" | "javascript";

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

/** Every extractor, in the order they are consulted. */
export const EXTRACTORS: readonly ImportExtractor[] = [tsJsExtractor];

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
