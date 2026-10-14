#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { auditSite, AuditError } from "./audit.js";
import { build } from "./build.js";
import { cacheClear, cacheStatus, CacheError, LockError } from "./cache.js";
import { ConfigError } from "./config.js";
import { HistoryError } from "./history.js";
import { PrivacyError } from "./privacy.js";
import { DEFAULT_PORT, DEFAULT_PORT_ATTEMPTS, openInBrowser, serve, ServeError } from "./serve.js";
import { InitError, initConfig } from "./init.js";
import { buildJson, formatBuildLine, formatBuildSummary } from "./report.js";
import { OutputError } from "./write.js";

const DEFAULT_OUT = "git-city-site";

/** Exit code for a failed privacy check (see SPEC §10). */
const EXIT_PRIVACY = 2;
/** Exit code when another run holds the cache lock (see SPEC §10). */
const EXIT_LOCKED = 3;

const HELP = `Usage: git-city [build] [options]
       git-city init [--shared]
       git-city serve [dir] [--port <n>] [--open]
       git-city audit [dir]
       git-city cache status|clear

Turns this repository's git history into an animated 3D City.
The man page is git-city(1).

Commands:
  build              build the site (the default)
  init               write a commented starter config (personal by default)
                     listing the detected Modules, External Dependencies and Themes
  serve [dir]        serve a built site on localhost (default dir: ${DEFAULT_OUT})
  audit [dir]        list every string in a built site (default dir: ${DEFAULT_OUT})
  cache status|clear inspect or remove the build cache in .git/git-city/

Options:
  -C <path>        run as if started in <path>
  --branch <name>  read this branch instead of the default branch
  --out <dir>      output folder (default: ${DEFAULT_OUT})
  --config <path>  read this config file instead of the shared and personal configs
  --shared         (init) write the shared config at the repo root instead
  --strict         fail the build on near-miss names
  --private        ignore every reveal in the config
  --theme <name>   the Theme for names and colours: modern or medieval
  --seed <text>    the seed for Generated names (overrides naming.seed)
  --fresh          rebuild the cache from scratch
  --wait           wait for another running build instead of failing
  --json           print the build result as JSON on stdout
  --quiet          print nothing on success (warnings and errors still show)
  --port <n>       port for serve, used exactly (default: the first free port
                   from ${DEFAULT_PORT} to ${DEFAULT_PORT + DEFAULT_PORT_ATTEMPTS - 1})
  --open           (serve) open the site in the browser
  -h, --help       show this help
  -v, --version    show the version

--strict and --private only make the output more private. Any flag beats the config for the same setting.
Exit codes: 0 success, 1 error, 2 privacy check failed, 3 another run holds the lock.
`;

/** Progress line for an interactive terminal: each phase overwrites the last on stderr. */
const CLEAR_LINE = "\r\x1b[2K";

/** Whether CI is set to a true value (CI=1, CI=true); CI=0 or CI=false does not count. */
function inCi(): boolean {
  const value = process.env.CI?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      directory: { type: "string", short: "C" },
      branch: { type: "string" },
      out: { type: "string" },
      config: { type: "string" },
      strict: { type: "boolean" },
      private: { type: "boolean" },
      theme: { type: "string" },
      seed: { type: "string" },
      fresh: { type: "boolean" },
      wait: { type: "boolean" },
      port: { type: "string" },
      json: { type: "boolean" },
      quiet: { type: "boolean" },
      shared: { type: "boolean" },
      open: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  const cwd = resolve(values.directory ?? ".");
  const [command = "build", ...rest] = positionals;

  if (command === "build" && rest.length === 0) {
    // Progress and the full summary are for a person at a terminal; CI gets one line.
    const interactive = process.stdout.isTTY === true && !inCi();
    const quiet = values.quiet === true;
    const progress = interactive && process.stderr.isTTY === true && !quiet && values.json !== true;
    let summary: Awaited<ReturnType<typeof build>>;
    try {
      summary = await build({
        repoDir: cwd,
        outDir: resolve(cwd, values.out ?? DEFAULT_OUT),
        branch: values.branch,
        configPath: values.config === undefined ? undefined : resolve(cwd, values.config),
        strict: values.strict,
        private: values.private,
        theme: values.theme,
        seed: values.seed,
        fresh: values.fresh,
        wait: values.wait,
        onPhase: progress ? (phase) => process.stderr.write(`${CLEAR_LINE}git-city: ${phase}...`) : undefined,
      });
    } finally {
      if (progress) process.stderr.write(CLEAR_LINE);
    }
    for (const warning of summary.warnings) process.stderr.write(`git-city: warning: ${warning}\n`);
    if (values.json) process.stdout.write(`${buildJson(summary)}\n`);
    else if (quiet) return 0;
    else if (interactive) process.stdout.write(formatBuildSummary(summary));
    else process.stdout.write(`${formatBuildLine(summary)}\n`);
    return 0;
  }

  if (command === "init" && rest.length === 0) {
    const written = await initConfig(cwd, { shared: values.shared === true });
    if (values.quiet !== true) process.stdout.write(`Wrote ${written}\n`);
    return 0;
  }

  if (command === "audit" && rest.length <= 1) {
    const lines = await auditSite(resolve(cwd, rest[0] ?? values.out ?? DEFAULT_OUT));
    process.stdout.write(lines.length ? `${lines.join("\n")}\n` : "");
    return 0;
  }

  if (command === "cache" && rest.length === 1 && (rest[0] === "status" || rest[0] === "clear")) {
    if (rest[0] === "status") {
      process.stdout.write(`${(await cacheStatus(cwd)).join("\n")}\n`);
    } else {
      const dir = await cacheClear(cwd, values.wait === true);
      process.stdout.write(`Cleared the cache at ${dir}\n`);
    }
    return 0;
  }

  if (command === "serve" && rest.length <= 1) {
    const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new UsageError(`invalid port: ${values.port}`);
    // A port the user names is used exactly; the default moves along to the next free port.
    const portAttempts = values.port === undefined ? DEFAULT_PORT_ATTEMPTS : 1;
    const server = await serve({ dir: resolve(cwd, rest[0] ?? values.out ?? DEFAULT_OUT), port, portAttempts });
    if (port !== 0 && new URL(server.url).port !== String(port)) process.stdout.write(`Port ${port} is in use.\n`);
    process.stdout.write(`Serving at ${server.url} (Ctrl+C to stop)\n`);
    if (values.open) openInBrowser(server.url);
    await new Promise<void>((done) => process.once("SIGINT", done).once("SIGTERM", done));
    await server.close();
    return 0;
  }

  throw new UsageError(`unknown command: ${positionals.join(" ")}`);
}

class UsageError extends Error {}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    const usage = e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") === true;
    const expected =
      usage ||
      e instanceof HistoryError ||
      e instanceof OutputError ||
      e instanceof ServeError ||
      e instanceof ConfigError ||
      e instanceof AuditError ||
      e instanceof InitError ||
      e instanceof CacheError ||
      e instanceof LockError ||
      e instanceof PrivacyError;
    process.stderr.write(`git-city: ${expected ? (e as Error).message : ((e as Error).stack ?? String(e))}\n`);
    if (usage) process.stderr.write(`Try "git-city --help".\n`);
    if (e instanceof LockError) process.exit(EXIT_LOCKED);
    process.exit(e instanceof PrivacyError ? EXIT_PRIVACY : 1);
  },
);
