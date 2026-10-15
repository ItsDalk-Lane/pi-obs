import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  applyPortPlaceholder,
  deriveNpmStartCommand,
  findNodeOnPath,
  isLikelyServerProcess,
  killTreeCommand,
  listenOwnerCommands,
  npmGlobalListArgs,
  npmGlobalRootArgs,
  npmInstallArgs,
  npmShellCommand,
  npmUninstallArgs,
  npmViewVersionArgs,
  parseListenerPids,
  parseNpmGlobalRoot,
  parseNpmGlobalVersion,
  parseNpmViewVersion,
  parsePackageVersion,
  parseProcessCommand,
  processQueryCommand,
  resolveNpmRunner,
} = await jiti.import("./pi-obs-server.ts");

// Real `netstat -ano` output shape on this machine (English headers/states).
const NETSTAT = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2052",
  "  TCP    127.0.0.1:30141        0.0.0.0:0              LISTENING       9964",
  "  TCP    127.0.0.1:301410       0.0.0.0:0              LISTENING       7777",
  "  TCP    127.0.0.1:30141        127.0.0.1:54929        ESTABLISHED     9964",
  "  TCP    127.0.0.1:30142        0.0.0.0:0              LISTENING       11111",
  "  TCP    [::1]:30141            [::]:0                 LISTENING       9964",
  "",
].join("\r\n");

const SS = [
  "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
  'LISTEN 0      511    127.0.0.1:30141    0.0.0.0:*         users:(("node",pid=9964,fd=20))',
  'LISTEN 0      511    127.0.0.1:301410   0.0.0.0:*         users:(("node",pid=7777,fd=20))',
  'ESTAB 0      0      127.0.0.1:30141    127.0.0.1:54929   users:(("node",pid=9964,fd=21))',
].join("\n");

test("listener lookup commands are ordered per platform", () => {
  assert.deepEqual(listenOwnerCommands(30141, "win32"), [{ command: "netstat", args: ["-ano"] }]);
  assert.deepEqual(listenOwnerCommands(30141, "darwin"), [
    { command: "lsof", args: ["-nP", "-iTCP:30141", "-sTCP:LISTEN", "-t"] },
  ]);
  const linux = listenOwnerCommands(30141, "linux");
  assert.equal(linux[0].command, "ss");
  assert.equal(linux[1].command, "lsof");
});

test("netstat listeners are matched by state, port and pid column", () => {
  // Only LISTENING rows whose LOCAL address ends in :30141; :301410 excluded.
  assert.deepEqual(parseListenerPids(NETSTAT, "win32", 30141), [9964]);
  assert.deepEqual(parseListenerPids(NETSTAT, "win32", 30142), [11111]);
  assert.deepEqual(parseListenerPids(NETSTAT, "win32", 30143), []);
});

test("bare pids (lsof -t) and ss rows both parse", () => {
  assert.deepEqual(parseListenerPids("9964\n", "darwin", 30141), [9964]);
  assert.deepEqual(parseListenerPids(SS, "linux", 30141), [9964]);
  assert.deepEqual(parseListenerPids("", "linux", 30141), []);
});

test("the kill command ends the pid and, on Windows, its tree", () => {
  assert.deepEqual(killTreeCommand(9964, "win32"), { command: "taskkill", args: ["/PID", "9964", "/T", "/F"] });
  assert.deepEqual(killTreeCommand(9964, "linux"), { command: "kill", args: ["9964"] });
});

test("the process query command differs per platform", () => {
  assert.deepEqual(processQueryCommand(9964, "win32"), {
    command: "tasklist",
    args: ["/FI", "PID eq 9964", "/FO", "CSV", "/NH"],
  });
  assert.deepEqual(processQueryCommand(9964, "darwin"), {
    command: "ps",
    args: ["-ww", "-p", "9964", "-o", "args="],
  });
});

test("tasklist CSV is read back, and an absent pid has no command", () => {
  assert.equal(parseProcessCommand('"node.exe","9964","Console","1","1,074,752 K"', "win32", 9964), "node.exe");
  // A pid that belongs to something else must not be reported as node.
  assert.equal(parseProcessCommand('"chrome.exe","500","Console","1","1 K"', "win32", 9964), "");
  assert.equal(parseProcessCommand("INFO: No tasks are running which match the specified criteria.", "win32", 9964), "");
  assert.equal(parseProcessCommand("node /x/next dev -H 127.0.0.1 -p 30141\n", "darwin", 9964), "node /x/next dev -H 127.0.0.1 -p 30141");
});

test("only node/next commands are treated as a server we may kill", () => {
  assert.equal(isLikelyServerProcess("node.exe", "win32"), true);
  assert.equal(isLikelyServerProcess("Node.EXE", "win32"), true);
  assert.equal(isLikelyServerProcess("chrome.exe", "win32"), false);
  assert.equal(isLikelyServerProcess(null, "win32"), false);
  assert.equal(isLikelyServerProcess("", "win32"), false);
  assert.equal(isLikelyServerProcess("node /x/node_modules/next/dist/bin/next dev", "darwin"), true);
  assert.equal(isLikelyServerProcess("next-server (v16.3.8)", "linux"), true);
  assert.equal(isLikelyServerProcess("/usr/lib/postgresql/bin/postgres", "linux"), false);
});

test("the real node is found on PATH, never Electron's execPath", () => {
  const separator = ";";
  const nodeExe = join("C:\\tools", "node.exe");
  assert.equal(findNodeOnPath(`C:\\other;${join("C:\\tools")}`, { fileExists: (p) => p === nodeExe, separator }), nodeExe);
  assert.equal(findNodeOnPath("C:\\other", { fileExists: () => false, separator }), null);
  assert.equal(findNodeOnPath(undefined, { fileExists: () => true, separator }), null);
  assert.equal(findNodeOnPath("", { fileExists: () => true, separator }), null);
  // A unix-style PATH entry resolves `node` without the .exe suffix.
  const unixNode = join("/usr/local/bin", "node");
  assert.equal(findNodeOnPath("/usr/bin:/usr/local/bin", { fileExists: (p) => p === unixNode, separator: ":" }), unixNode);
});

test("npm is run through node without a shell, or not at all", () => {
  const separator = ";";
  const nodeExe = join("C:\\tools", "node.exe");
  const npmCli = join("C:\\tools", "cli", "npm-cli.js");
  assert.deepEqual(
    resolveNpmRunner(["view", "pi-obs", "version", "--json"], { pathEnv: join("C:\\tools"), fileExists: (p) => p === nodeExe, separator, npmCliPath: npmCli }),
    { command: nodeExe, args: [npmCli, "view", "pi-obs", "version", "--json"] },
  );
  assert.equal(resolveNpmRunner([], { pathEnv: undefined, separator, npmCliPath: npmCli }), null);
});

test("npm argument builders", () => {
  assert.deepEqual(npmViewVersionArgs("pi-obs"), ["view", "pi-obs", "version", "--json"]);
  assert.deepEqual(npmGlobalListArgs("pi-obs"), ["ls", "-g", "pi-obs", "--json", "--depth", "0"]);
  assert.deepEqual(npmGlobalRootArgs(), ["prefix", "-g"]);
  assert.deepEqual(npmInstallArgs({ pkg: "pi-obs", version: "0.12.1", scope: "global", prefixDir: "C:\\p" }), ["install", "-g", "pi-obs@0.12.1"]);
  assert.deepEqual(npmInstallArgs({ pkg: "pi-obs", scope: "plugin", prefixDir: "C:\\p" }), ["install", "pi-obs", "--prefix", "C:\\p"]);
  assert.deepEqual(npmUninstallArgs({ pkg: "pi-obs", scope: "global", prefixDir: "C:\\p" }), ["uninstall", "-g", "pi-obs"]);
  assert.deepEqual(npmUninstallArgs({ pkg: "pi-obs", scope: "plugin", prefixDir: "C:\\p" }), ["uninstall", "pi-obs", "--prefix", "C:\\p"]);
});

test("shell lines quote what needs quoting", () => {
  assert.equal(npmShellCommand(["install", "-g", "pi-obs"]), "npm install -g pi-obs");
  assert.equal(npmShellCommand(["install", "pi-obs", "--prefix", "C:\\Program Files\\x"]), 'npm install pi-obs --prefix "C:\\Program Files\\x"');
});

test("package.json and npm view outputs are parsed defensively", () => {
  assert.equal(parsePackageVersion('{"version":"0.12.1"}'), "0.12.1");
  assert.equal(parsePackageVersion("{}"), null);
  assert.equal(parsePackageVersion("npm error code E404"), null);
  assert.equal(parseNpmViewVersion('"0.12.1"'), "0.12.1");
  assert.equal(parseNpmViewVersion(""), null);
  assert.equal(parseNpmViewVersion("npm error 404 Not Found"), null);
  assert.equal(parseNpmGlobalVersion('{"dependencies":{"pi-obs":{"version":"0.12.1"}}}', "pi-obs"), "0.12.1");
  assert.equal(parseNpmGlobalVersion('{"dependencies":{}}', "pi-obs"), null);
  assert.equal(parseNpmGlobalVersion("", "pi-obs"), null);
});

test("npm prefix -g's single path line is the global root", () => {
  assert.equal(parseNpmGlobalRoot("C:\\Users\\x\\AppData\\Roaming\\npm\r\n"), "C:\\Users\\x\\AppData\\Roaming\\npm");
  assert.equal(parseNpmGlobalRoot("\n/home/x/.npm-global\n"), "/home/x/.npm-global");
  assert.equal(parseNpmGlobalRoot(""), null);
  assert.equal(parseNpmGlobalRoot("   \r\n  \n"), null);
});

test("the npm start command follows the install scope", () => {
  assert.equal(deriveNpmStartCommand({ scope: "global", installDir: "C:\\p", pkg: "pi-obs", port: 30141 }), "pi-obs -p {port}");
  const plugin = deriveNpmStartCommand({ scope: "plugin", installDir: "C:\\p\\pi-obs-app", pkg: "pi-obs", port: 30141 });
  assert.equal(plugin, `node "${join("C:\\p\\pi-obs-app", "node_modules", "pi-obs", "bin", "pi-obs.js")}" -p {port} --no-open`);
  const scoped = deriveNpmStartCommand({ scope: "plugin", installDir: "C:\\p\\pi-obs-app", pkg: "@x/y", port: 30141 });
  assert.match(scoped, /node_modules[\\/]@x[\\/]y[\\/]bin[\\/]pi-obs\.js/);
});

test("the port placeholder is filled, and a command without one is untouched", () => {
  assert.equal(applyPortPlaceholder("pi-obs -p {port}", 30141), "pi-obs -p 30141");
  assert.equal(applyPortPlaceholder("node x.js -p {port} --no-open", 4000), "node x.js -p 4000 --no-open");
  assert.equal(applyPortPlaceholder("npm run dev", 30141), "npm run dev");
});
