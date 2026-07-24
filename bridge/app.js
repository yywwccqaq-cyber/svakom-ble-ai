import { randomUUID, timingSafeEqual } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

const DEFAULT_DURATION_SECONDS = 30;
const DEFAULT_MAX_DURATION_SECONDS = 300;
const DEFAULT_COMMAND_TTL_MS = 5_000;
const DEFAULT_BRIDGE_ONLINE_WINDOW_MS = 4_000;
const DEFAULT_ACTION_ARM_TTL_MS = 30_000;
const KNOWN_CAPABILITIES = new Set(["vibration", "stretch", "suction"]);
const KNOWN_ACTIONS = new Set(["speed", "pattern", "stretch", "suction"]);

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

function textResult(message, data = {}, rejected = false) {
  // Kelivo currently loses some MCP results carrying `isError: true`, which
  // leaves an orphaned Anthropic tool_use block and breaks the next request.
  // Business-level rejections stay fail-closed, but travel as ordinary text
  // results with an explicit `ok: false` payload so the client records them.
  const details = `\n${JSON.stringify({ ok: !rejected, ...data })}`;
  return {
    content: [{ type: "text", text: `${message}${details}` }],
  };
}

function commandKind(command) {
  if (command.stop) return "stop";
  if (command.action) return command.action;
  if (command.pattern) return "vibration_pattern";
  return "vibration";
}

function parseCapabilities(value) {
  return [...new Set(String(value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => KNOWN_CAPABILITIES.has(item)))];
}

function safeProfile(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["sl278h", "sl278k"].includes(normalized) ? normalized : null;
}

function safeHex(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{2,128}$/.test(normalized) && normalized.length % 2 === 0
    ? normalized
    : null;
}

function boundedAgeMs(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(parsed, 86_400_000);
}

export class RelayState {
  constructor({
    now = () => Date.now(),
    commandTtlMs = DEFAULT_COMMAND_TTL_MS,
    bridgeOnlineWindowMs = DEFAULT_BRIDGE_ONLINE_WINDOW_MS,
    actionArmTtlMs = DEFAULT_ACTION_ARM_TTL_MS,
  } = {}) {
    this.now = now;
    this.commandTtlMs = commandTtlMs;
    this.bridgeOnlineWindowMs = bridgeOnlineWindowMs;
    this.actionArmTtlMs = actionArmTtlMs;
    this.lastBridgeSeenAt = null;
    this.bridgeReady = false;
    this.bridgeProfile = null;
    this.bridgeCapabilities = [];
    this.bleNotifications = { ffe2: null, ae02: null };
    this.pending = null;
    this.lastDelivered = null;
    this.activeEstimate = null;
    this.actionArm = null;
  }

  touchBridge(ready, { profile, capabilities = [], notifications = {} } = {}) {
    this.lastBridgeSeenAt = this.now();
    this.bridgeReady = Boolean(ready);
    this.bridgeProfile = this.bridgeReady ? safeProfile(profile) : null;
    this.bridgeCapabilities = this.bridgeReady
      ? capabilities.filter((item) => KNOWN_CAPABILITIES.has(item))
      : [];
    if (this.bridgeReady) {
      for (const channel of ["ffe2", "ae02"]) {
        const hex = safeHex(notifications[channel]?.hex);
        const ageMs = boundedAgeMs(notifications[channel]?.ageMs);
        if (hex && ageMs !== null) {
          this.bleNotifications[channel] = {
            hex,
            observedAt: this.now() - ageMs,
          };
        }
      }
    }
    if (!this.bridgeReady) {
      if (this.pending && !this.pending.command.stop) this.pending = null;
      this.activeEstimate = null;
      this.actionArm = null;
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

  supports(capability) {
    return this.isDeviceReady() && this.bridgeCapabilities.includes(capability);
  }

  prune() {
    const currentTime = this.now();
    if (this.pending && this.pending.expiresAt <= currentTime) {
      this.pending = null;
    }
    if (this.activeEstimate && this.activeEstimate.until <= currentTime) {
      this.activeEstimate = null;
    }
    if (this.actionArm && this.actionArm.expiresAt <= currentTime) {
      this.actionArm = null;
    }
  }

  armAction(action) {
    this.prune();
    if (!this.isDeviceReady() || !KNOWN_ACTIONS.has(action)) return null;
    const createdAt = this.now();
    this.actionArm = {
      token: randomUUID(),
      action,
      createdAt,
      expiresAt: createdAt + this.actionArmTtlMs,
    };
    return { ...this.actionArm };
  }

  consumeActionToken(token, action) {
    this.prune();
    if (
      !this.isDeviceReady() ||
      !this.actionArm ||
      this.actionArm.action !== action ||
      !constantTimeEqual(this.actionArm.token, token)
    ) {
      return false;
    }
    this.actionArm = null;
    return true;
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
            kind: commandKind(this.pending.command),
          }
        : null,
      active_estimate: this.activeEstimate
        ? {
            kind: commandKind(this.activeEstimate.command),
            remaining_seconds: Math.max(
              0,
              Math.ceil((this.activeEstimate.until - now) / 1_000),
            ),
          }
        : null,
      action_arm: this.actionArm
        ? {
            action: this.actionArm.action,
            remaining_seconds: Math.max(
              0,
              Math.ceil((this.actionArm.expiresAt - now) / 1_000),
            ),
          }
        : null,
      device_profile: deviceReady ? this.bridgeProfile : null,
      capabilities: deviceReady ? [...this.bridgeCapabilities] : [],
      ble_notifications: Object.fromEntries(
        Object.entries(this.bleNotifications).map(([channel, entry]) => [
          channel,
          entry
            ? {
                hex: entry.hex,
                age_seconds: Math.max(
                  0,
                  Math.round((now - entry.observedAt) / 1_000),
                ),
              }
            : null,
        ]),
      ),
    };
  }
}

function createToyMcpServer(state, { maxDurationSeconds }) {
  const server = new McpServer({
    name: "svakom-kelivo-bridge",
    version: "1.2.1",
  });

  const requireReady = () => {
    if (state.isDeviceReady()) return null;
    return textResult(
      "蓝牙中继或设备尚未就绪。请先在设备附近的电脑启动 bridge.py，并确认它显示“就绪”。",
      state.snapshot(),
      true,
    );
  };

  const requireCapability = (capability, label) => {
    const notReady = requireReady();
    if (notReady) return notReady;
    if (state.supports(capability)) return null;
    return textResult(
      `当前蓝牙设备没有报告“${label}”能力，未发送动作。`,
      state.snapshot(),
      true,
    );
  };

  const requireActionToken = (token, action) => {
    if (state.consumeActionToken(token, action)) return null;
    return textResult(
      "动作令牌无效、已使用或已过期，未发送动作。请在用户当前明确要求动作后，重新调用 toy_arm_action 获取一次性令牌。",
      { requested_action: action, ...state.snapshot() },
      true,
    );
  };

  server.registerTool(
    "toy_arm_action",
    {
      title: "为一次设备动作解锁",
      description:
        "仅在用户当前明确要求执行设备动作后调用。为指定动作签发一个 30 秒内有效、仅可使用一次的令牌；旧调用或重复调用无法复用。停止设备不需要令牌。",
      inputSchema: {
        action: z
          .enum(["speed", "pattern", "stretch", "suction"])
          .describe("即将执行的动作类型"),
      },
    },
    async ({ action }) => {
      const notReady = requireReady();
      if (notReady) return notReady;
      const arm = state.armAction(action);
      if (!arm) {
        return textResult("无法签发动作令牌，设备当前未就绪。", state.snapshot(), true);
      }
      return textResult(
        `已为 ${action} 签发一次性动作令牌；30 秒内使用一次后立即失效。`,
        {
          action,
          action_token: arm.token,
          expires_in_seconds: Math.ceil(state.actionArmTtlMs / 1_000),
        },
      );
    },
  );

  server.registerTool(
    "toy_set_speed",
    {
      title: "设置设备强度",
      description:
        "仅在用户明确要求控制设备时调用。非零动作必须先调用 toy_arm_action(action=speed) 并传入一次性令牌；0 表示立即停止且不需要令牌。",
      inputSchema: {
        action_token: z
          .string()
          .optional()
          .describe("toy_arm_action 为 speed 签发的一次性令牌；speed=0 时可省略"),
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
    async ({ action_token, speed, duration_seconds }) => {
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
      const invalidToken = requireActionToken(action_token, "speed");
      if (invalidToken) return invalidToken;
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
        "仅在用户明确要求控制设备时调用。必须先调用 toy_arm_action(action=pattern) 并传入一次性令牌。",
      inputSchema: {
        action_token: z
          .string()
          .optional()
          .describe("toy_arm_action 为 pattern 签发的一次性令牌"),
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
    async ({ action_token, pattern, level, duration_seconds }) => {
      const notReady = requireReady();
      if (notReady) return notReady;
      const invalidToken = requireActionToken(action_token, "pattern");
      if (invalidToken) return invalidToken;
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
    "toy_set_stretch",
    {
      title: "设置伸缩模式",
      description:
        "仅在用户明确要求伸缩动作时调用。必须先调用 toy_arm_action(action=stretch) 并传入一次性令牌；不会启动吸吮或加热。",
      inputSchema: {
        action_token: z
          .string()
          .optional()
          .describe("toy_arm_action 为 stretch 签发的一次性令牌"),
        mode: z.number().int().min(1).max(7).describe("伸缩模式，1 到 7"),
        strength: z
          .number()
          .min(0.1)
          .max(1)
          .default(0.3)
          .describe("伸缩强度，0.1 到 1；首次建议 0.1"),
        duration_seconds: z
          .number()
          .int()
          .min(1)
          .max(maxDurationSeconds)
          .default(DEFAULT_DURATION_SECONDS)
          .describe(`运行秒数，最长 ${maxDurationSeconds} 秒`),
      },
    },
    async ({ action_token, mode, strength, duration_seconds }) => {
      const unavailable = requireCapability("stretch", "伸缩");
      if (unavailable) return unavailable;
      const invalidToken = requireActionToken(action_token, "stretch");
      if (invalidToken) return invalidToken;
      const entry = state.enqueue({
        action: "stretch",
        mode,
        level: strength,
        sec: duration_seconds,
      });
      return textResult(
        `已排队：伸缩模式 ${mode}，强度 ${Math.round(strength * 100)}%，运行 ${duration_seconds} 秒后自动停止。`,
        {
          queued: true,
          command_id: entry.id,
          action: "stretch",
          mode,
          strength,
          duration_seconds,
        },
      );
    },
  );

  server.registerTool(
    "toy_set_suction",
    {
      title: "设置吸吮模式",
      description:
        "仅在用户明确要求吸吮动作时调用。必须先调用 toy_arm_action(action=suction) 并传入一次性令牌；不会启动伸缩或加热。",
      inputSchema: {
        action_token: z
          .string()
          .optional()
          .describe("toy_arm_action 为 suction 签发的一次性令牌"),
        mode: z.number().int().min(1).max(5).describe("吸吮模式，1 到 5"),
        strength: z
          .number()
          .min(0.1)
          .max(1)
          .default(0.3)
          .describe("吸吮强度，0.1 到 1；首次建议 0.1"),
        duration_seconds: z
          .number()
          .int()
          .min(1)
          .max(maxDurationSeconds)
          .default(DEFAULT_DURATION_SECONDS)
          .describe(`运行秒数，最长 ${maxDurationSeconds} 秒`),
      },
    },
    async ({ action_token, mode, strength, duration_seconds }) => {
      const unavailable = requireCapability("suction", "吸吮");
      if (unavailable) return unavailable;
      const invalidToken = requireActionToken(action_token, "suction");
      if (invalidToken) return invalidToken;
      const entry = state.enqueue({
        action: "suction",
        mode,
        level: strength,
        sec: duration_seconds,
      });
      return textResult(
        `已排队：吸吮模式 ${mode}，强度 ${Math.round(strength * 100)}%，运行 ${duration_seconds} 秒后自动停止。`,
        {
          queued: true,
          command_id: entry.id,
          action: "suction",
          mode,
          strength,
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

  server.registerTool(
    "toy_ble_status",
    {
      title: "查看 BLE 特征状态",
      description:
        "只读查看设备型号、已启用能力，以及 FFE2/AE02 最近一次通知；不会写入任何 BLE 特征。",
      inputSchema: {},
    },
    async () => {
      const status = state.snapshot();
      return textResult(
        status.device_ready
          ? "已读取 BLE 能力与通知状态。"
          : "蓝牙设备未就绪；返回最近可用的只读状态。",
        status,
        !status.device_ready,
      );
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
    state.touchBridge(ready, {
      profile: request.get("x-bridge-profile"),
      capabilities: parseCapabilities(request.get("x-bridge-capabilities")),
      notifications: {
        ffe2: {
          hex: request.get("x-bridge-ffe2"),
          ageMs: request.get("x-bridge-ffe2-age-ms"),
        },
        ae02: {
          hex: request.get("x-bridge-ae02"),
          ageMs: request.get("x-bridge-ae02-age-ms"),
        },
      },
    });
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
