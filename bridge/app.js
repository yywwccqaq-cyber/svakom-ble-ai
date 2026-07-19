import { randomUUID, timingSafeEqual } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

const DEFAULT_DURATION_SECONDS = 30;
const DEFAULT_MAX_DURATION_SECONDS = 300;
const DEFAULT_COMMAND_TTL_MS = 5_000;
const DEFAULT_BRIDGE_ONLINE_WINDOW_MS = 4_000;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""));
  const rightBuffer = Buffer.from(String(right ?? ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(request) {
  const value = request.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() ?? "";
}

function textResult(message, data = {}, isError = false) {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

export class RelayState {
  constructor({
    now = () => Date.now(),
    commandTtlMs = DEFAULT_COMMAND_TTL_MS,
    bridgeOnlineWindowMs = DEFAULT_BRIDGE_ONLINE_WINDOW_MS,
  } = {}) {
    this.now = now;
    this.commandTtlMs = commandTtlMs;
    this.bridgeOnlineWindowMs = bridgeOnlineWindowMs;
    this.lastBridgeSeenAt = null;
    this.bridgeReady = false;
    this.pending = null;
    this.lastDelivered = null;
    this.activeEstimate = null;
  }

  touchBridge(ready) {
    this.lastBridgeSeenAt = this.now();
    this.bridgeReady = Boolean(ready);
    if (!this.bridgeReady) {
      if (this.pending && !this.pending.command.stop) this.pending = null;
      this.activeEstimate = null;
    }
  }

  isBridgeAlive() {
    return (
      this.lastBridgeSeenAt !== null &&
      this.now() - this.lastBridgeSeenAt <= this.bridgeOnlineWindowMs
    );
  }

  isDeviceReady() {
    return this.isBridgeAlive() && this.bridgeReady;
  }

  prune() {
    const currentTime = this.now();
    if (this.pending && this.pending.expiresAt <= currentTime) {
      this.pending = null;
    }
    if (this.activeEstimate && this.activeEstimate.until <= currentTime) {
      this.activeEstimate = null;
    }
  }

  enqueue(command, { ttlMs = this.commandTtlMs } = {}) {
    const createdAt = this.now();
    const entry = {
      id: randomUUID(),
      command: { ...command },
      createdAt,
      expiresAt: createdAt + ttlMs,
    };
    // A single latest-command slot prevents old actions from replaying later.
    this.pending = entry;
    return entry;
  }

  takePending() {
    this.prune();
    if (!this.isDeviceReady() || !this.pending) return null;

    const entry = this.pending;
    this.pending = null;
    this.lastDelivered = {
      id: entry.id,
      command: { ...entry.command },
      deliveredAt: this.now(),
    };

    if (entry.command.stop) {
      this.activeEstimate = null;
    } else {
      this.activeEstimate = {
        command: { ...entry.command },
        until: this.now() + Number(entry.command.sec) * 1_000,
      };
    }

    return { ...entry.command, command_id: entry.id };
  }

  snapshot() {
    this.prune();
    const now = this.now();
    const bridgeAlive = this.isBridgeAlive();
    const deviceReady = this.isDeviceReady();
    return {
      bridge_polling: bridgeAlive,
      device_ready: deviceReady,
      last_bridge_seen_seconds_ago:
        this.lastBridgeSeenAt === null
          ? null
          : Math.max(0, Math.round((now - this.lastBridgeSeenAt) / 1_000)),
      pending_command: this.pending
        ? {
            id: this.pending.id,
            kind: this.pending.command.stop
              ? "stop"
              : this.pending.command.pattern
                ? "pattern"
                : "speed",
          }
        : null,
      active_estimate: this.activeEstimate
        ? {
            kind: this.activeEstimate.command.pattern ? "pattern" : "speed",
            remaining_seconds: Math.max(
              0,
              Math.ceil((this.activeEstimate.until - now) / 1_000),
            ),
          }
        : null,
    };
  }
}

function createToyMcpServer(state, { maxDurationSeconds }) {
  const server = new McpServer({
    name: "svakom-kelivo-bridge",
    version: "1.0.0",
  });

  const requireReady = () => {
    if (state.isDeviceReady()) return null;
    return textResult(
      "蓝牙中继或设备尚未就绪。请先在设备附近的电脑启动 bridge.py，并确认它显示“就绪”。",
      state.snapshot(),
      true,
    );
  };

  server.registerTool(
    "toy_set_speed",
    {
      title: "设置设备强度",
      description:
        "仅在用户明确要求控制设备时调用。把强度设置为 0 到 1，并在有限时长后自动停止；0 表示立即停止。",
      inputSchema: {
        speed: z
          .number()
          .min(0)
          .max(1)
          .describe("强度，0 到 1；例如 0.5 表示 50%"),
        duration_seconds: z
          .number()
          .int()
          .min(1)
          .max(maxDurationSeconds)
          .default(DEFAULT_DURATION_SECONDS)
          .describe(`运行秒数，最长 ${maxDurationSeconds} 秒`),
      },
    },
    async ({ speed, duration_seconds }) => {
      if (speed === 0) {
        const entry = state.enqueue(
          { stop: true },
          { ttlMs: Math.max(state.commandTtlMs, 60_000) },
        );
        return textResult("已发送停止指令。", {
          queued: true,
          command_id: entry.id,
          action: "stop",
        });
      }

      const notReady = requireReady();
      if (notReady) return notReady;
      const entry = state.enqueue({ speed, sec: duration_seconds });
      return textResult(
        `已排队：强度 ${Math.round(speed * 100)}%，运行 ${duration_seconds} 秒后自动停止。`,
        {
          queued: true,
          command_id: entry.id,
          speed,
          duration_seconds,
        },
      );
    },
  );

  server.registerTool(
    "toy_set_pattern",
    {
      title: "设置振动花样",
      description:
        "仅在用户明确要求控制设备时调用。设置 1 到 8 档花样和 0 到 1 的强度，并在有限时长后自动停止。",
      inputSchema: {
        pattern: z.number().int().min(1).max(8).describe("花样档位，1 到 8"),
        level: z
          .number()
          .min(0)
          .max(1)
          .default(0.6)
          .describe("强度，0 到 1"),
        duration_seconds: z
          .number()
          .int()
          .min(1)
          .max(maxDurationSeconds)
          .default(DEFAULT_DURATION_SECONDS)
          .describe(`运行秒数，最长 ${maxDurationSeconds} 秒`),
      },
    },
    async ({ pattern, level, duration_seconds }) => {
      const notReady = requireReady();
      if (notReady) return notReady;
      const entry = state.enqueue({ pattern, level, sec: duration_seconds });
      return textResult(
        `已排队：花样 ${pattern}，强度 ${Math.round(level * 100)}%，运行 ${duration_seconds} 秒后自动停止。`,
        {
          queued: true,
          command_id: entry.id,
          pattern,
          level,
          duration_seconds,
        },
      );
    },
  );

  server.registerTool(
    "toy_stop",
    {
      title: "立即停止设备",
      description: "立即停止设备。停止指令会优先覆盖尚未发送的动作。",
      inputSchema: {},
    },
    async () => {
      const entry = state.enqueue(
        { stop: true },
        { ttlMs: Math.max(state.commandTtlMs, 60_000) },
      );
      return textResult(
        state.isDeviceReady()
          ? "已发送停止指令。"
          : "停止指令已保留；但蓝牙中继当前未就绪，无法确认设备已停止。",
        {
          queued: true,
          command_id: entry.id,
          device_ready: state.isDeviceReady(),
        },
        !state.isDeviceReady(),
      );
    },
  );

  server.registerTool(
    "toy_status",
    {
      title: "查看设备状态",
      description: "查看电脑蓝牙中继是否在线、设备是否就绪，以及是否有待发送指令。",
      inputSchema: {},
    },
    async () => {
      const status = state.snapshot();
      const message = status.device_ready
        ? "蓝牙中继在线，设备已就绪。"
        : status.bridge_polling
          ? "电脑中继在线，但蓝牙设备尚未就绪。"
          : "蓝牙中继离线。";
      return textResult(message, status);
    },
  );

  return server;
}

export function createRelayApp({
  secret,
  state = new RelayState(),
  maxDurationSeconds = DEFAULT_MAX_DURATION_SECONDS,
} = {}) {
  const normalizedSecret = String(secret ?? "").trim();
  if (normalizedSecret.length < 24) {
    throw new Error("BRIDGE_SECRET must contain at least 24 characters");
  }

  const maximumDuration = boundedInteger(
    maxDurationSeconds,
    DEFAULT_MAX_DURATION_SECONDS,
    DEFAULT_DURATION_SECONDS,
    3_600,
  );
  const app = createMcpExpressApp({ host: "0.0.0.0" });

  const requireMcpAuth = (request, response, next) => {
    if (constantTimeEqual(bearerToken(request), normalizedSecret)) return next();
    response.set("WWW-Authenticate", "Bearer");
    return response.status(401).json({ error: "unauthorized" });
  };

  const requireBridgeAuth = (request, response, next) => {
    if (
      constantTimeEqual(request.get("x-bridge-secret") ?? "", normalizedSecret)
    ) {
      return next();
    }
    return response.status(401).json({ error: "unauthorized" });
  };

  app.get("/health", (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.json({ ok: true, service: "svakom-kelivo-bridge" });
  });

  app.get("/toy-next", requireBridgeAuth, (request, response) => {
    const ready = request.get("x-bridge-ready") === "1";
    state.touchBridge(ready);
    response.set("Cache-Control", "no-store");
    const command = state.takePending();
    response.json(
      command ?? {
        type: "hello",
        device_ready: state.isDeviceReady(),
      },
    );
  });

  app.post("/mcp", requireMcpAuth, async (request, response) => {
    const server = createToyMcpServer(state, {
      maxDurationSeconds: maximumDuration,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP request failed:", error instanceof Error ? error.message : error);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  const methodNotAllowed = (_request, response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  };
  app.get("/mcp", requireMcpAuth, methodNotAllowed);
  app.delete("/mcp", requireMcpAuth, methodNotAllowed);

  return { app, state };
}

export function configFromEnvironment(environment = process.env) {
  return {
    secret: environment.BRIDGE_SECRET,
    maxDurationSeconds: boundedInteger(
      environment.MAX_DURATION_SECONDS,
      DEFAULT_MAX_DURATION_SECONDS,
      DEFAULT_DURATION_SECONDS,
      3_600,
    ),
  };
}
