import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const values = await jiti.import("./mcp-config-values.ts");
const transport = await jiti.import("./mcp-transport.ts");
const { configValueEnvVarNames, isCommandConfigValue } = await jiti.import("./mcp-import.ts");
const { loadPiSdkInternals } = await jiti.import("./pi-sdk-internals.ts");

const internals = await loadPiSdkInternals();
assert.equal(internals.ok, true, internals.reason);

test("the server uses the very same value walk and PI_OBS_PASSWORD rule", () => {
  assert.equal(transport.resolvedConfigValues, values.resolvedConfigValues);
  assert.equal(transport.findWebPasswordField, values.findWebPasswordField);
  assert.equal(transport.WEB_PASSWORD_VARIABLE, "PI_OBS_PASSWORD");
});

test("the browser's parsers find PI_OBS_PASSWORD where the SDK's do", () => {
  const browser = { isCommandConfigValue, getConfigValueEnvVarNames: configValueEnvVarNames };
  for (const config of [
    { command: "x", env: { A: "${PI_OBS_PASSWORD}" } },
    { command: "x", env: { A: "$pi_obs_password" } },
    { command: "x", env: { A: "$$PI_OBS_PASSWORD" } },
    { command: "x", env: { A: "!echo $PI_OBS_PASSWORD" } },
    { url: "https://x.example/mcp", headers: { Authorization: "Bearer ${PI_OBS_PASSWORD}" } },
    { url: "https://x.example/mcp", oauth: { clientSecret: "${PI_OBS_PASSWORD}" } },
    { url: "https://x.example/mcp", env: { A: "${PI_OBS_PASSWORD}" } },
    { command: "x", headers: { A: "${PI_OBS_PASSWORD}" } },
  ]) {
    assert.deepEqual(values.findWebPasswordField(config, browser), values.findWebPasswordField(config, internals), JSON.stringify(config));
  }
});
