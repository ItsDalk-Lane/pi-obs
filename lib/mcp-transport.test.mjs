import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { loadPiSdkInternals } = await jiti.import("./pi-sdk-internals.ts");
const {
  createPiObsMcpTransportFactory,
  findWebPasswordField,
  findWebPasswordReference,
  resolvedConfigValues,
} = await jiti.import("./mcp-transport.ts");

const FIXTURE = fileURLToPath(new URL("./__fixtures__/mcp-env-server.mjs", import.meta.url));

const internals = await loadPiSdkInternals();
assert.equal(internals.ok, true, internals.reason);

const HOST_ENVIRONMENT = {
  PI_OBS_PASSWORD: "web-password",
  PORT: "30141",
  NODE_ENV: "production",
  NEXT_TEST: "1",
  PI_OBS_TEST_REFERENCED: "referenced-value",
  PI_OBS_TEST_INHERITED: "inherited-value",
};

async function withHostEnvironment(run) {
  const previous = Object.fromEntries(Object.keys(HOST_ENVIRONMENT).map((name) => [name, process.env[name]]));
  Object.assign(process.env, HOST_ENVIRONMENT);
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function stdioEntry(config = {}) {
  return { name: "env-fixture", config: { command: process.execPath, args: [FIXTURE], ...config }, source: "test" };
}

// Created before any test changes process.env: the factory must read the
// environment when a server starts, not when the factory is made.
const piObsFactory = createPiObsMcpTransportFactory(internals);

/** A connection through pi-obs's factory, recording the transports it builds. */
function connect(entry, factory = piObsFactory) {
  const transports = [];
  const connection = new internals.McpServerConnection({
    entry,
    cwd: tmpdir(),
    createTransport: (...args) => {
      const transport = factory(...args);
      transports.push(transport);
      return transport;
    },
    credentials: new internals.McpOAuthCredentialStore(),
    onTools: () => {},
  });
  return { connection, transports };
}

async function callTool(connection, name, args) {
  const result = await connection.callTool(name, args, {});
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent;
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitUntilExited(pid) {
  for (let attempt = 0; attempt < 100 && isRunning(pid); attempt++) await delay(50);
  return !isRunning(pid);
}

test("stdio servers start without the variables that configure or guard pi-obs", async () => {
  await withHostEnvironment(async () => {
    const { connection, transports } = connect(stdioEntry({
      env: {
        FROM_CONFIG: "literal-value",
        FROM_REFERENCE: "${PI_OBS_TEST_REFERENCED}",
        FROM_COMMAND: "!echo command-value",
        ESCAPED: "$${PI_OBS_TEST_REFERENCED}",
      },
    }));
    try {
      await connection.getClient();
      assert.equal(connection.state, "connected");
      assert.ok(connection.tools.some((tool) => tool.name === "env_has"));

      for (const name of ["PI_OBS_PASSWORD", "PORT", "NODE_ENV", "NEXT_TEST"]) {
        assert.deepEqual(await callTool(connection, "env_has", { name }), { has: false }, `${name} reached the server`);
      }
      assert.deepEqual(await callTool(connection, "env_get", { name: "PI_OBS_TEST_INHERITED" }), { value: "inherited-value" });
      assert.deepEqual(await callTool(connection, "env_get", { name: "FROM_CONFIG" }), { value: "literal-value" });
      assert.deepEqual(await callTool(connection, "env_get", { name: "FROM_REFERENCE" }), { value: "referenced-value" });
      assert.deepEqual(await callTool(connection, "env_get", { name: "FROM_COMMAND" }), { value: "command-value" });
      assert.deepEqual(await callTool(connection, "env_get", { name: "ESCAPED" }), { value: "${PI_OBS_TEST_REFERENCED}" });

      assert.equal(transports.length, 1);
      assert.ok(transports[0] instanceof internals.StdioTransport);
      assert.equal(transports[0].options.inheritEnv, false);
    } finally {
      await connection.close();
    }
  });
});

test("a stdio server's stderr reaches the connection error", async () => {
  // McpServerConnection keeps stderr only from instances of the StdioTransport
  // class runtime.js imports, so a second copy of pi-mcp loses it.
  const { connection } = connect(stdioEntry({ env: { PI_OBS_FIXTURE_FAIL: "fixture cannot start" } }));
  try {
    await assert.rejects(connection.getClient(), /failed to connect: [^]*fixture cannot start/);
    assert.equal(connection.state, "failed");
    assert.match(connection.error, /fixture cannot start/);
  } finally {
    await connection.close();
  }
});

test("closing the connection ends the server and the processes it started", { skip: process.platform === "win32" }, async () => {
  const { connection, transports } = connect(stdioEntry());
  let serverPid;
  let childPid;
  try {
    await connection.getClient();
    serverPid = transports[0].pid;
    ({ pid: childPid } = await callTool(connection, "spawn_child", {}));
    assert.ok(isRunning(serverPid));
    assert.ok(isRunning(childPid));
  } finally {
    await connection.close();
  }
  assert.ok(await waitUntilExited(serverPid), `server ${serverPid} is still running`);
  assert.ok(await waitUntilExited(childPid), `child ${childPid} is still running`);
});

test("an entry's own env applies on top of the sanitized environment", () => {
  const factory = createPiObsMcpTransportFactory(internals, {
    baseEnvironment: {
      PI_OBS_PASSWORD: "web-password",
      PORT: "30141",
      NODE_ENV: "production",
      NEXT_RUNTIME: "nodejs",
      HOME: "/home/pi",
    },
    platform: "linux",
  });
  const transport = factory(stdioEntry({ env: { NODE_ENV: "development", TOKEN: "literal" } }), "/work", undefined);
  assert.deepEqual(transport.options.env, { HOME: "/home/pi", NODE_ENV: "development", TOKEN: "literal" });
  assert.equal(transport.options.inheritEnv, false);
});

test("on Windows, names match whatever their casing", () => {
  const factory = createPiObsMcpTransportFactory(internals, {
    baseEnvironment: { Path: "C:\\bin", Pi_Obs_Password: "web-password", Port: "30141", SystemRoot: "C:\\Windows" },
    platform: "win32",
  });
  const transport = factory(stdioEntry({ env: { PATH: "D:\\tools" } }), "C:\\work", undefined);
  assert.deepEqual(transport.options.env, { SystemRoot: "C:\\Windows", PATH: "D:\\tools" });
});

test("stdio transports keep every option the SDK's transport passes", () => {
  const entry = stdioEntry({ command: "~/bin/server", args: ["~/data", "--flag"], cwd: "sub", env: { TOKEN: "literal" } });
  const sdkTransport = internals.createDefaultTransport(entry, "/work", undefined);
  const transport = createPiObsMcpTransportFactory(internals)(entry, "/work", undefined);

  assert.ok(transport instanceof internals.StdioTransport);
  assert.notEqual(transport, sdkTransport);
  assert.equal(transport.pid, undefined);
  const { env, inheritEnv, ...options } = transport.options;
  assert.deepEqual({ ...options, env: sdkTransport.options.env }, sdkTransport.options);
  assert.equal(inheritEnv, false);
  assert.equal(env.TOKEN, "literal");
});

test("HTTP servers use the SDK's transport unchanged", async () => {
  await withHostEnvironment(() => {
    const entry = {
      name: "remote",
      config: { url: "https://mcp.example.com/mcp", headers: { "X-Reference": "${PI_OBS_TEST_REFERENCED}" } },
      source: "test",
    };
    const authProvider = { token: async () => "token" };
    const sdkTransport = internals.createDefaultTransport(entry, "/work", authProvider);
    const transport = createPiObsMcpTransportFactory(internals)(entry, "/work", authProvider);

    assert.equal(transport.constructor, sdkTransport.constructor);
    assert.ok(!(transport instanceof internals.StdioTransport));
    assert.deepEqual(transport.options, sdkTransport.options);
    assert.deepEqual(transport.options.headers, { "X-Reference": "referenced-value" });
    assert.equal(transport.options.authProvider, authProvider);
  });
});

test("refuses entries whose resolved values reference PI_OBS_PASSWORD", () => {
  const refused = [
    [stdioEntry({ env: { TOKEN: "${PI_OBS_PASSWORD}" } }), 'env "TOKEN"'],
    [stdioEntry({ env: { TOKEN: "$PI_OBS_PASSWORD" } }), 'env "TOKEN"'],
    [stdioEntry({ env: { OTHER: "x", TOKEN: "Bearer ${PI_OBS_PASSWORD}" } }), 'env "TOKEN"'],
    [stdioEntry({ env: { TOKEN: "${pi_obs_password}" } }), 'env "TOKEN"'],
    [stdioEntry({ env: { TOKEN: "!printenv PI_OBS_PASSWORD" } }), 'env "TOKEN"'],
    [
      { name: "remote", config: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer $PI_OBS_PASSWORD" } }, source: "test" },
      'header "Authorization"',
    ],
    [
      { name: "remote", config: { url: "https://mcp.example.com/mcp", oauth: { clientId: "id", clientSecret: "${PI_OBS_PASSWORD}" } }, source: "test" },
      "oauth.clientSecret",
    ],
  ];
  let sdkCalls = 0;
  const factory = createPiObsMcpTransportFactory({
    ...internals,
    createDefaultTransport: (...args) => {
      sdkCalls++;
      return internals.createDefaultTransport(...args);
    },
  });
  for (const [entry, field] of refused) {
    assert.equal(findWebPasswordReference(entry.config, internals), field);
    assert.throws(
      () => factory(entry, "/work", undefined),
      new RegExp(`MCP server "${entry.name}" ${field} references PI_OBS_PASSWORD`),
    );
  }
  // Refused before the SDK resolves anything, so no `!command` ran.
  assert.equal(sdkCalls, 0);

  for (const value of ["$${PI_OBS_PASSWORD}", "${PI_OBS_PASSWORD_HINT}", "literal PI_OBS_PASSWORD"]) {
    assert.equal(findWebPasswordReference({ command: "server", env: { TOKEN: value } }, internals), undefined, value);
  }
});

test("a refused entry fails to connect without starting a process", async () => {
  await withHostEnvironment(async () => {
    const { connection, transports } = connect(stdioEntry({ env: { TOKEN: "${PI_OBS_PASSWORD}" } }));
    try {
      await assert.rejects(connection.getClient(), /references PI_OBS_PASSWORD/);
      assert.equal(connection.state, "failed");
      assert.equal(transports.length, 0);
    } finally {
      await connection.close();
    }
  });
});

test("never falls back to a transport pi-obs did not sanitize", () => {
  const notStdio = createPiObsMcpTransportFactory({ ...internals, createDefaultTransport: () => ({}) });
  assert.throws(() => notStdio(stdioEntry(), "/work", undefined), /the SDK did not create a stdio transport/);

  const extraEnvironment = createPiObsMcpTransportFactory({
    ...internals,
    createDefaultTransport: () => new internals.StdioTransport({ command: "server", env: { HOME: "/home/pi" } }),
  });
  assert.throws(
    () => extraEnvironment(stdioEntry(), "/work", undefined),
    /the SDK set environment variable HOME, which its config does not declare/,
  );
});

test("the values pi resolves are walked as the transport walks them, on unvalidated entries too", () => {
  assert.deepEqual(resolvedConfigValues({ command: "server", env: { A: "1", B: 2, C: "${C}" }, headers: { H: "ignored" } }), [
    { kind: "env", name: "A", value: "1" },
    { kind: "env", name: "C", value: "${C}" },
  ]);
  assert.deepEqual(
    resolvedConfigValues({ url: "https://x.example/mcp", env: { A: "ignored" }, headers: { H: "v" }, oauth: { clientSecret: "s" } }),
    [{ kind: "header", name: "H", value: "v" }, { kind: "oauth-client-secret", value: "s" }],
  );
  for (const config of [null, "string", [], { env: "not a map" }, { url: 1, headers: ["x"], oauth: "x" }]) {
    assert.deepEqual(resolvedConfigValues(config), [], JSON.stringify(config));
  }
  assert.deepEqual(
    findWebPasswordField({ url: "https://x.example/mcp", oauth: { clientSecret: "!pass show $PI_OBS_PASSWORD" } }, internals),
    { kind: "oauth-client-secret" },
  );
  assert.deepEqual(findWebPasswordField({ command: "s", env: { X: 5, Y: "${pi_obs_password}" } }, internals), { kind: "env", name: "Y" });
});
