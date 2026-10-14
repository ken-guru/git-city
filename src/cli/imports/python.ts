import type { Resolution } from "./resolve.js";

/**
 * Python import resolution (SPEC §4, Resolve). A specifier from a `.py` file is resolved against the commit's paths
 * only: leading-dot relative imports from the importer's package, and absolute imports under each source root.
 * `exists` records every path it checks, so the graph can re-resolve the import when one of them changes.
 */

/** Source roots, in the order absolute imports try them, from the commit's paths and config. */
export function pythonSourceRoots(paths: ReadonlySet<string>, read: (path: string) => string | undefined): string[] {
  // The repository root and src/ are always roots, so a src/ that appears later is picked up without a config change.
  const roots = new Set<string>(["", "src"]);
  for (const path of paths) {
    if (!isPyproject(path)) continue;
    const dir = dirnameOf(path);
    roots.add(dir);
    const text = read(path);
    if (text === undefined) continue;
    for (const declared of declaredSourceRoots(text)) roots.add(joinPath(dir, declared));
  }
  return [...roots];
}

interface PythonContext {
  /** Whether a path is in the commit. Records the probe. */
  exists(path: string): boolean;
  /** Source roots from `pythonSourceRoots`. */
  roots: readonly string[];
}

/** Resolves a Python import from `fromPath`. `specifier` is the module as written, with its leading dots; `member` is a `from` import's name. */
export function resolvePythonImport(ctx: PythonContext, fromPath: string, specifier: string, member?: string): Resolution | undefined {
  const dots = specifier.length - specifier.replace(/^\.+/, "").length;
  const parts = specifier.slice(dots).split(".").filter((part) => part !== "");
  if (dots > 0) {
    // One dot is the importer's own package; each further dot climbs one package.
    let base = dirnameOf(fromPath);
    for (let i = 1; i < dots; i++) {
      // Climbing above the repository root names nothing.
      if (base === "") return undefined;
      base = dirnameOf(base);
    }
    return moduleIn(ctx, base, parts, member);
  }
  for (const root of orderRoots(ctx.roots, dirnameOf(fromPath))) {
    const hit = moduleIn(ctx, root, parts, member);
    if (hit) return hit;
  }
  // Not in the repo: the standard library is dropped; anything else is a package, named by its top-level module.
  if (parts.length === 0 || STDLIB.has(parts[0]!)) return undefined;
  return { kind: "package", name: parts[0]! };
}

/** The module `parts` under `base`, or with a `from` import's `member` as a submodule of it when that exists. */
function moduleIn(ctx: PythonContext, base: string, parts: string[], member: string | undefined): Resolution | undefined {
  if (member !== undefined) {
    const sub = moduleFile(ctx, base, [...parts, member]);
    if (sub) return sub;
  }
  return moduleFile(ctx, base, parts);
}

/**
 * The file a module names: `a/b.py`, or the package's `a/b/__init__.py`. Parent directories need no __init__.py,
 * so a PEP 420 namespace package resolves through its modules. With no parts, only the package's own __init__.py counts.
 */
function moduleFile(ctx: PythonContext, base: string, parts: string[]): Resolution | undefined {
  const stem = joinPath(base, parts.join("/"));
  if (stem === "") return undefined;
  const candidates = parts.length === 0 ? [`${stem}/__init__.py`] : [`${stem}.py`, `${stem}/__init__.py`];
  for (const candidate of candidates) {
    if (ctx.exists(candidate)) return { kind: "file", path: candidate };
  }
  return undefined;
}

/** Roots that contain the importer come first (deepest first), then the rest (deepest first). */
function orderRoots(roots: readonly string[], fromDir: string): string[] {
  const enclosing = (root: string) => root === "" || fromDir === root || fromDir.startsWith(`${root}/`);
  const depth = (root: string) => (root === "" ? 0 : root.split("/").length);
  return [...roots].sort((a, b) => Number(!enclosing(a)) - Number(!enclosing(b)) || depth(b) - depth(a));
}

/** Whether a path is a Python source file, whose imports follow Python's rules. */
export function isPythonFile(path: string): boolean {
  return /\.py$/i.test(path);
}

/** Whether a path is a pyproject.toml, which declares Python source roots. */
export function isPyproject(path: string): boolean {
  return path === "pyproject.toml" || path.endsWith("/pyproject.toml");
}

/**
 * Source roots a pyproject.toml declares (relative to its directory): pytest's `pythonpath`, pyright's `extraPaths`,
 * mypy's `mypy_path`, and setuptools' `packages.find.where`. Read with a small line scanner, not a full TOML parser.
 */
function declaredSourceRoots(text: string): string[] {
  const wanted: [string, string][] = [
    ["tool.pytest.ini_options", "pythonpath"],
    ["tool.pyright", "extraPaths"],
    ["tool.mypy", "mypy_path"],
    ["tool.setuptools.packages.find", "where"],
  ];
  const found: string[] = [];
  for (const [table, key] of wanted) {
    const body = tableBody(text, table);
    const value = new RegExp(`^\\s*${key}\\s*=\\s*(\\[[^\\]]*\\]|"[^"]*"|'[^']*')`, "m").exec(body)?.[1];
    if (value === undefined) continue;
    for (const match of value.matchAll(/"([^"]*)"|'([^']*)'/g)) found.push(match[1] ?? match[2] ?? "");
  }
  return found.filter((path) => path !== "");
}

/** The lines under a `[table]` header, up to the next header. */
function tableBody(text: string, table: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (start === -1) return "";
  const end = lines.findIndex((line, i) => i > start && /^\s*\[/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

function dirnameOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/** Joins and collapses "." and ".." segments. The root is "". */
function joinPath(dir: string, rel: string): string {
  const out: string[] = [];
  for (const part of `${dir}/${rel}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** Top-level module names of the Python standard library (3.12), which are never Roads or External Dependencies. */
const STDLIB = new Set(
  `__future__ __main__ _ast _asyncio _bisect _codecs _collections _contextvars _csv _ctypes _datetime _decimal _functools
  _heapq _imp _io _json _locale _md5 _operator _pickle _posixsubprocess _random _sha1 _sha2 _signal _socket _sqlite3 _sre
  _ssl _stat _string _struct _symtable _thread _threading_local _tkinter _tracemalloc _typing _uuid _warnings _weakref
  _weakrefset _winapi abc aifc antigravity argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii
  binhex bisect builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall
  concurrent configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm decimal
  difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions
  ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib
  imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap
  marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib nt ntpath nturl2path numbers
  opcode operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix
  posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline reprlib
  resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket
  socketserver spwd sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct subprocess sunau
  symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios textwrap this threading time timeit tkinter token
  tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv
  warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc xxlimited zipapp zipfile zipimport zlib zoneinfo`
    .split(/\s+/)
    .filter((name) => name !== ""),
);
