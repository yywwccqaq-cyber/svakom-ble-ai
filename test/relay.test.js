import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createRelayApp, RelayState } from "../bridge/app.js";

const SECRET = "test-secret-that-is-longer-than-24-characters";
let baseUrl;
let httpServer;
let client;
let transport;

function resultData(result) {
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  const separator = text.indexOf("\n");
  return separator >= 0 ? JSON.parse(text.slice(separator + 1)) : {};
}

function assertRejected(result) {
  assert.notEqual(result.isError, true);
  assert.equal(resultData(result).ok, false);
}

async function armAction(action) {
  const result = await client.callTool({
    name: "toy_arm_action",
    arguments: { action },
  });
  assert.notEqual(result.isError, true);
  const data = resultData(result);
  assert.equal(data.ok, true);
  assert.equal(data.action, action);
  assert.equal(typeof data.action_token, "string");
  return data.action_token;
}

before(async () => {
  const state = new RelayState();
  const { app } = createRelayApp({ secret: SECRET, state });
  httpServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => httpServer.once("listening", resolve));
  const { port } = httpServer.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await transport?.close().catch(() => {});
  await new Promise((resolve) => httpServer.close(resolve));
});

test("health endpoint is public and MCP endpoint rejects missing auth", async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: "svakom-kelivo-bridge",
  });

  const unauthorized = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "unauthorized-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(unauthorized.status, 401);
});

test("Kelivo-style Streamable HTTP client lists all tools", async () => {
  transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${SECRET}` },
    },
  });
  client = new Client({ name: "kelivo-compatible-test", version: "1.0.0" });
  await client.connect(transport);

  const result = await client.listTools();
  assert.deepEqual(
    result.tools.map((tool) => tool.name).sort(),
    [
      "toy_arm_action",
      "toy_ble_status",
      "toy_set_pattern",
      "toy_set_speed",
      "toy_set_stretch",
      "toy_set_suction",
      "toy_status",
      "toy_stop",
    ],
  );
});

test("MCP call responses use the preferred SSE transport", async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 91,
      method: "tools/call",
      params: { name: "toy_status", arguments: {} },
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  const body = await response.text();
  assert.match(body, /event: message/);
  assert.match(body, /"jsonrpc":"2.0"/);
  assert.match(body, /"id":91/);
  assert.match(body, /\\"ok\\":true/);
});

test("authenticated MCP audit records metadata but never tool arguments", async () => {
  const response = await fetch(`${baseUrl}/mcp-audit`, {
    headers: { "x-bridge-secret": SECRET },
  });
  assert.equal(response.status, 200);
  const audit = await response.json();
  assert.equal(audit.ok, true);
  const statusCall = audit.entries.find((entry) =>
    entry.requests.some(
      (request) =>
        request.method === "tools/call" && request.tool_name === "toy_status",
    ),
  );
  assert.equal(statusCall.completed, true);
  assert.equal(statusCall.response_status, 200);
  assert.match(statusCall.response_content_type, /^text\/event-stream/);
  assert.equal(JSON.stringify(audit).includes("arguments"), false);
  assert.equal(JSON.stringify(audit).includes(SECRET), false);

  const unauthorized = await fetch(`${baseUrl}/mcp-audit`);
  assert.equal(unauthorized.status, 401);
});

test("activation is rejected until the BLE device reports ready", async () => {
  const result = await client.callTool({
    name: "toy_set_speed",
    arguments: { speed: 0.5, duration_seconds: 10 },
  });
  assertRejected(result);
});

test("action tokens expire after their short safety window", () => {
  let now = 1_000;
  const state = new RelayState({
    now: () => now,
    bridgeOnlineWindowMs: 60_000,
    actionArmTtlMs: 1_000,
  });
  state.touchBridge(true);
  const armed = state.armAction("speed");
  assert.equal(typeof armed?.token, "string");

  now += 1_001;
  assert.equal(state.consumeActionToken(armed.token, "speed"), false);
  assert.equal(state.actionArm, null);
});

test("ready bridge receives a finite-duration command exactly once", async () => {
  const pollHeaders = {
    "x-bridge-secret": SECRET,
    "x-bridge-ready": "1",
  };
  const firstPoll = await fetch(`${baseUrl}/toy-next`, { headers: pollHeaders });
  assert.equal(firstPoll.status, 200);
  assert.equal((await firstPoll.json()).type, "hello");

  const staleReplay = await client.callTool({
    name: "toy_set_speed",
    arguments: { speed: 0.65, duration_seconds: 12 },
  });
  assertRejected(staleReplay);
  const afterRejectedReplay = await fetch(`${baseUrl}/toy-next`, {
    headers: pollHeaders,
  });
  assert.equal((await afterRejectedReplay.json()).type, "hello");

  const actionToken = await armAction("speed");
  const call = await client.callTool({
    name: "toy_set_speed",
    arguments: {
      action_token: actionToken,
      speed: 0.65,
      duration_seconds: 12,
    },
  });
  assert.notEqual(call.isError, true);

  const commandResponse = await fetch(`${baseUrl}/toy-next`, {
    headers: pollHeaders,
  });
  const command = await commandResponse.json();
  assert.equal(command.speed, 0.65);
  assert.equal(command.sec, 12);
  assert.equal(typeof command.command_id, "string");

  const secondPoll = await fetch(`${baseUrl}/toy-next`, { headers: pollHeaders });
  assert.equal((await secondPoll.json()).type, "hello");

  const repeatedCall = await client.callTool({
    name: "toy_set_speed",
    arguments: {
      action_token: actionToken,
      speed: 0.65,
      duration_seconds: 12,
    },
  });
  assertRejected(repeatedCall);
  const afterRepeatedCall = await fetch(`${baseUrl}/toy-next`, {
    headers: pollHeaders,
  });
  assert.equal((await afterRepeatedCall.json()).type, "hello");
});

test("actuator-specific tools reject a bridge that did not report capabilities", async () => {
  const actionToken = await armAction("stretch");
  const result = await client.callTool({
    name: "toy_set_stretch",
    arguments: {
      action_token: actionToken,
      mode: 1,
      strength: 0.1,
      duration_seconds: 3,
    },
  });
  assertRejected(result);
});

test("SL278K capabilities enable bounded stretch, suction, and BLE status", async () => {
  const sl278kHeaders = {
    "x-bridge-secret": SECRET,
    "x-bridge-ready": "1",
    "x-bridge-profile": "sl278k",
    "x-bridge-capabilities": "vibration,stretch,suction,unknown",
    "x-bridge-ffe2": "55aa",
    "x-bridge-ffe2-age-ms": "120",
    "x-bridge-ae02": "0102",
    "x-bridge-ae02-age-ms": "250",
  };

  await fetch(`${baseUrl}/toy-next`, { headers: sl278kHeaders });

  const stretchToken = await armAction("stretch");
  const stretchCall = await client.callTool({
    name: "toy_set_stretch",
    arguments: {
      action_token: stretchToken,
      mode: 2,
      strength: 0.1,
      duration_seconds: 3,
    },
  });
  assert.notEqual(stretchCall.isError, true);
  const stretch = await (
    await fetch(`${baseUrl}/toy-next`, { headers: sl278kHeaders })
  ).json();
  assert.equal(stretch.action, "stretch");
  assert.equal(stretch.mode, 2);
  assert.equal(stretch.level, 0.1);
  assert.equal(stretch.sec, 3);

  const suctionToken = await armAction("suction");
  const suctionCall = await client.callTool({
    name: "toy_set_suction",
    arguments: {
      action_token: suctionToken,
      mode: 1,
      strength: 0.1,
      duration_seconds: 3,
    },
  });
  assert.notEqual(suctionCall.isError, true);
  const suction = await (
    await fetch(`${baseUrl}/toy-next`, { headers: sl278kHeaders })
  ).json();
  assert.equal(suction.action, "suction");
  assert.equal(suction.mode, 1);
  assert.equal(suction.level, 0.1);
  assert.equal(suction.sec, 3);

  const status = await client.callTool({
    name: "toy_ble_status",
    arguments: {},
  });
  assert.notEqual(status.isError, true);
  assert.equal(status.structuredContent, undefined);
  const statusData = resultData(status);
  assert.equal(statusData.device_profile, "sl278k");
  assert.deepEqual(statusData.capabilities, [
    "vibration",
    "stretch",
    "suction",
  ]);
  assert.equal(statusData.ble_notifications.ffe2.hex, "55aa");
  assert.equal(statusData.ble_notifications.ae02.hex, "0102");
});

test("a disconnect clears unsafe pending actions but retains stop", async () => {
  const readyHeaders = {
    "x-bridge-secret": SECRET,
    "x-bridge-ready": "1",
  };
  const disconnectedHeaders = {
    "x-bridge-secret": SECRET,
    "x-bridge-ready": "0",
  };

  await fetch(`${baseUrl}/toy-next`, { headers: readyHeaders });
  const patternToken = await armAction("pattern");
  await client.callTool({
    name: "toy_set_pattern",
    arguments: {
      action_token: patternToken,
      pattern: 3,
      level: 0.7,
      duration_seconds: 10,
    },
  });
  const disconnectedToken = await armAction("speed");
  await fetch(`${baseUrl}/toy-next`, { headers: disconnectedHeaders });
  const afterReconnect = await fetch(`${baseUrl}/toy-next`, {
    headers: readyHeaders,
  });
  assert.equal((await afterReconnect.json()).type, "hello");

  const staleAfterDisconnect = await client.callTool({
    name: "toy_set_speed",
    arguments: {
      action_token: disconnectedToken,
      speed: 0.2,
      duration_seconds: 3,
    },
  });
  assertRejected(staleAfterDisconnect);
  const afterStaleToken = await fetch(`${baseUrl}/toy-next`, {
    headers: readyHeaders,
  });
  assert.equal((await afterStaleToken.json()).type, "hello");

  await client.callTool({ name: "toy_stop", arguments: {} });
  const stopResponse = await fetch(`${baseUrl}/toy-next`, {
    headers: readyHeaders,
  });
  assert.equal((await stopResponse.json()).stop, true);
});
