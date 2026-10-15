// Helpers for the locally running pi-obs server, used by the Obsidian plugin:
// find the process listening on the configured port (so a server started from
// another terminal can be stopped too), kill it, and drive npm through a real
// Node.js install.
//
// Electron trap: `process.execPath` is Obsidian itself, not node, so
// `lib/node-cli.ts`'s default lookup (dirName(execPath)) cannot work inside the
// plugin. The real `node` is looked up on PATH instead and npm is then spawned
// without a shell.
//
// Everything here is pure or takes its I/O as parameters, so `node --test` can
// cover it (see lib/pi-obs-server.test.mjs).

import { existsSync } from "fs";
import { delimiter, dirname, join } from "path";
import { findNodeCliScript } from "./node-cli";

export type Platform = NodeJS.Platform;

export interface CommandSpec {
  command: string;
  args: string[];
}

export interface LookupOptions {
  /** Probe used to test a candidate path, injectable for tests. */
  fileExists?: (path: string) => boolean;
}

export interface PathLookupOptions extends LookupOptions {
  /** Directory separator of `pathEnv`. Defaults to the running platform's. */
  separator?: string;
}

function isValidPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

/**
 * Commands that list the pids listening on `port`, most likely to work first.
 * Windows has `netstat`; macOS has `lsof`; Linux usually has `ss` (whose pids
 * are only shown for your own processes) with `lsof` as a fallback.
 */
export function listenOwnerCommands(port: number, platform: Platform): CommandSpec[] {
  if (platform === "win32") return [{ command: "netstat", args: ["-ano"] }];
  // `-t` makes lsof print bare pids, which needs no table parsing.
  const lsof: CommandSpec = { command: "lsof", args: ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"] };
  if (platform === "darwin") return [lsof];
  return [{ command: "ss", args: ["-ltnp"] }, lsof];
}

/** The last field of a `netstat -ano` line, a bare pid, or `pid=<n>`. */
export function parseListenerPids(stdout: string, platform: Platform, port: number): number[] {
  const pids = new Set<number>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (platform === "win32") {
      // Proto  Local Address  Foreign Address  State  PID
      const fields = line.split(/\s+/);
      if (fields.length < 5) continue;
      if (fields[3] !== "LISTENING") continue;
      if (!fields[1].endsWith(`:${port}`)) continue;
      const pid = Number(fields[4]);
      if (isValidPid(pid)) pids.add(pid);
      continue;
    }

    // unix: `lsof -t` prints bare pids; `ss -ltnp` prints a table with
    // `users:(("node",pid=1234,fd=20))`. Never match `:301410` for port 30141.
    const bare = /^(\d+)$/.exec(line);
    if (bare) {
      const pid = Number(bare[1]);
      if (isValidPid(pid)) pids.add(pid);
      continue;
    }
    const pidMatch = /pid=(\d+)/.exec(line);
    if (!pidMatch) continue;
    if (!new RegExp(`:${port}(?![0-9])`).test(line)) continue;
    const pid = Number(pidMatch[1]);
    if (isValidPid(pid)) pids.add(pid);
  }
  return [...pids];
}

/** End `pid` and, on Windows, everything it spawned (`shell: true` children). */
export function killTreeCommand(pid: number, platform: Platform): CommandSpec {
  return platform === "win32"
    ? { command: "taskkill", args: ["/PID", String(pid), "/T", "/F"] }
    : { command: "kill", args: [String(pid)] };
}

/** Command that prints where `pid` is used; its output is read back in. */
export function processQueryCommand(pid: number, platform: Platform): CommandSpec {
  return platform === "win32"
    ? { command: "tasklist", args: ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"] }
    : { command: "ps", args: ["-ww", "-p", String(pid), "-o", "args="] };
}

/** `pid`'s command line (Windows: its image name), "" when it does not exist. */
export function parseProcessCommand(stdout: string, platform: Platform, pid: number): string {
  if (platform !== "win32") return (stdout.split(/\r?\n/).find((line) => line.trim()) ?? "").trim();
  // `"node.exe","1234",...`, or an INFO line when nothing matches.
  const match = /^"([^"]*)","(\d+)"/.exec(stdout.trim());
  return match && match[2] === String(pid) ? match[1] : "";
}

/**
 * Whether a listener at `port` looks like one of ours before it is killed: a
 * pi-obs server always runs under node (next dev, or node bin/pi-obs.js). A
 * pid whose command line cannot be read (null) is not confirmed either.
 */
export function isLikelyServerProcess(command: string | null, platform: Platform): boolean {
  if (command === null || command === "") return false;
  if (platform === "win32") return /^node(\.exe)?$/i.test(command);
  return /node|next|pi-obs/i.test(command);
}

/** The real `node` executable on PATH, or null (Electron's execPath is not it). */
export function findNodeOnPath(pathEnv: string | undefined, options: PathLookupOptions = {}): string | null {
  if (!pathEnv) return null;
  const fileExists = options.fileExists ?? existsSync;
  const separator = options.separator ?? delimiter;
  for (const dir of pathEnv.split(separator)) {
    if (!dir) continue;
    for (const name of ["node.exe", "node"]) {
      const candidate = join(dir, name);
      try {
        if (fileExists(candidate)) return candidate;
      } catch {
        // ignore an unreadable PATH entry
      }
    }
  }
  return null;
}

export interface NpmRunnerOptions extends PathLookupOptions {
  /** The PATH searched for node. Defaults to the running process's own. */
  pathEnv?: string | undefined;
  /** Explicit npm-cli.js, skipping the PATH lookup (tests, unusual layouts). */
  npmCliPath?: string | null;
}

/**
 * `{command,args}` that runs npm without a shell, or null when no Node.js
 * installation can be found. Windows' `npm.cmd` cannot be spawned by
 * `execFile` (CVE-2024-27980), which is why this goes through node.
 */
export function resolveNpmRunner(args: string[], options: NpmRunnerOptions = {}): CommandSpec | null {
  const nodePath = findNodeOnPath(options.pathEnv, options);
  if (!nodePath) return null;
  const npmCli = options.npmCliPath
    ?? findNodeCliScript("npm", { nodeDir: dirname(nodePath), fileExists: options.fileExists });
  if (!npmCli) return null;
  return { command: nodePath, args: [npmCli, ...args] };
}

/** A shell line for npm, used when no Node.js install can be located. */
export function npmShellCommand(args: string[]): string {
  const quoted = args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg));
  return ["npm", ...quoted].join(" ");
}

export interface PackageSpec {
  pkg: string;
  version?: string;
}

export function npmViewVersionArgs(pkg: string): string[] {
  return ["view", pkg, "version", "--json"];
}

/** Global install listing: `npm ls -g <pkg> --json` (depth 0 keeps it small). */
export function npmGlobalListArgs(pkg: string): string[] {
  return ["ls", "-g", pkg, "--json", "--depth", "0"];
}

/** Where global installs land: `npm prefix -g`. */
export function npmGlobalRootArgs(): string[] {
  return ["prefix", "-g"];
}

export interface NpmInstallOptions {
  pkg: string;
  version?: string;
  scope: "global" | "plugin";
  /** Where the plugin-scope install lands (`<pluginFolder>/pi-obs-app`). */
  prefixDir: string;
}

function packageSpec({ pkg, version }: PackageSpec): string {
  const trimmed = version?.trim();
  return trimmed ? `${pkg}@${trimmed}` : pkg;
}

export function npmInstallArgs(options: NpmInstallOptions): string[] {
  const spec = packageSpec(options);
  return options.scope === "global"
    ? ["install", "-g", spec]
    : ["install", spec, "--prefix", options.prefixDir];
}

export function npmUninstallArgs(options: { pkg: string; scope: "global" | "plugin"; prefixDir: string }): string[] {
  return options.scope === "global"
    ? ["uninstall", "-g", options.pkg]
    : ["uninstall", options.pkg, "--prefix", options.prefixDir];
}

/** The `version` field of a package.json, or null when it is unusable. */
export function parsePackageVersion(jsonText: string): string | null {
  try {
    const parsed = JSON.parse(jsonText) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

/** `npm view <pkg> version --json` output. Null on E404 or any other failure. */
export function parseNpmViewVersion(stdout: string): string | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
  } catch {
    return null;
  }
}

/** The installed version inside `npm ls -g <pkg> --json` output. */
export function parseNpmGlobalVersion(stdout: string, pkg: string): string | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { dependencies?: Record<string, { version?: unknown }> };
    const version = parsed.dependencies?.[pkg]?.version;
    return typeof version === "string" && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

/** The path line of `npm prefix -g` output; null when it printed nothing. */
export function parseNpmGlobalRoot(stdout: string): string | null {
  return stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

export interface NpmStartCommandOptions {
  scope: "global" | "plugin";
  /** `<pluginFolder>/pi-obs-app`, where a plugin-scope install lands. */
  installDir: string;
  pkg: string;
  port: number;
}

/**
 * The default command that starts the server in npm mode. `{port}` is left in
 * for `applyPortPlaceholder`, so editing the port setting is enough.
 */
export function deriveNpmStartCommand(options: NpmStartCommandOptions): string {
  if (options.scope === "global") return `${options.pkg} -p {port}`;
  const parts = options.pkg.startsWith("@") ? options.pkg.split("/") : [options.pkg];
  const bin = join(options.installDir, "node_modules", ...parts, "bin", "pi-obs.js");
  return `node "${bin}" -p {port} --no-open`;
}

/** Fill `{port}` in a start command; a command without it is left alone. */
export function applyPortPlaceholder(command: string, port: number): string {
  return command.replace(/\{port\}/g, String(port));
}
