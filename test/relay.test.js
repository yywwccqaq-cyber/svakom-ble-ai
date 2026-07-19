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

test("activation is rejected until the BLE device reports ready", async () => {
  const result = await client.callTool({
    name: "toy_set_speed",
    arguments: { speed: 0.5, duration_seconds: 10 },
  });
  assert.equal(result.isError, true);
});

test("ready bridge receives a finite-duration command exactly once", async () => {
  const pollHeaders = {
    "x-bridge-secret": SECRET,
    "x-bridge-ready": "1",
  };
  const firstPoll = await fetch(`${baseUrl}/toy-next`, { headers: pollHeaders });
  assert.equal(firstPoll.status, 200);
  assert.equal((await firstPoll.json()).type, "hello");

  const call = await client.callTool({
    name: "toy_set_speed",
    arguments: { speed: 0.65, duration_seconds: 12 },
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
});

test("actuator-specific tools reject a bridge that did not report capabilities", async () => {
  const result = await client.callTool({
    name: "toy_set_stretch",
    arguments: { mode: 1, strength: 0.1, duration_seconds: 3 },
  });
  assert.equal(result.isError, true);
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

  const stretchCall = await client.callTool({
    name: "toy_set_stretch",
    arguments: { mode: 2, strength: 0.1, duration_seconds: 3 },
  });
  assert.notEqual(stretchCall.isError, true);
  const stretch = await (
    await fetch(`${baseUrl}/toy-next`, { headers: sl278kHeaders })
  ).json();
  assert.equal(stretch.action, "stretch");
  assert.equal(stretch.mode, 2);
  assert.equal(stretch.level, 0.1);
  assert.equal(stretch.sec, 3);

  const suctionCall = await client.callTool({
    name: "toy_set_suction",
    arguments: { mode: 1, strength: 0.1, duration_seconds: 3 },
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
  assert.equal(status.structuredContent.device_profile, "sl278k");
  assert.deepEqual(status.structuredContent.capabilities, [
    "vibration",
    "stretch",
    "suction",
  ]);
  assert.equal(status.structuredContent.ble_notifications.ffe2.hex, "55aa");
  assert.equal(status.structuredContent.ble_notifications.ae02.hex, "0102");
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
  await client.callTool({
    name: "toy_set_pattern",
    arguments: { pattern: 3, level: 0.7, duration_seconds: 10 },
  });
  await fetch(`${baseUrl}/toy-next`, { headers: disconnectedHeaders });
  const afterReconnect = await fetch(`${baseUrl}/toy-next`, {
    headers: readyHeaders,
  });
  assert.equal((await afterReconnect.json()).type, "hello");

  await client.callTool({ name: "toy_stop", arguments: {} });
  const stopResponse = await fetch(`${baseUrl}/toy-next`, {
    headers: readyHeaders,
  });
  assert.equal((await stopResponse.json()).stop, true);
});
