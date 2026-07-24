# Kelivo + Railway 部署说明

这套补充实现把项目分成两部分：

- Railway：运行标准 MCP（Streamable HTTP）和短时命令队列，不接触蓝牙。
- 设备附近的 Windows/Mac/Linux 电脑：运行 `bridge.py`，连接 SL278H 或 SL278K 并轮询 Railway。

## 1. Railway 配置

仓库推送完成后，现有 Railway 项目会自动重新部署。进入服务的 **Variables**，添加：

| 变量 | 必填 | 建议值 |
| --- | --- | --- |
| `BRIDGE_SECRET` | 是 | 至少 32 个随机字符；不要提交到 GitHub |
| `MAX_DURATION_SECONDS` | 否 | `300`（默认值） |

部署成功后，在 **Settings → Networking → Generate Domain** 生成公开域名。健康检查地址应返回 JSON：

```text
https://你的域名/health
```

## 2. Kelivo 添加 MCP

在 Kelivo 的 MCP 页面添加服务器：

- 名称：`SVAKOM`
- 类型：`HTTP / Streamable HTTP`
- URL：`https://你的域名/mcp`
- 请求头：
  - 名称：`Authorization`
  - 值：`Bearer 你的BRIDGE_SECRET`

密钥放在请求头里，不要拼到 URL。也可以在 Kelivo 的 MCP JSON 编辑器中导入：

```json
{
  "mcpServers": {
    "svakom": {
      "name": "SVAKOM",
      "type": "streamableHttp",
      "description": "SVAKOM BLE 安全中继",
      "isActive": true,
      "baseUrl": "https://你的域名/mcp",
      "headers": {
        "Authorization": "Bearer 你的BRIDGE_SECRET"
      }
    }
  }
}
```

连接成功后会显示八个工具：

- `toy_status`
- `toy_ble_status`（只读显示能力与 FFE2/AE02 最近通知）
- `toy_arm_action`（为一次动作签发 30 秒有效、仅可使用一次的令牌）
- `toy_set_speed`
- `toy_set_pattern`
- `toy_set_stretch`（SL278K 伸缩模式 1–7）
- `toy_set_suction`（SL278K 吸吮模式 1–5）
- `toy_stop`

在 SL278K 上，`toy_set_speed` 使用与初始化序列相同、实机有响应迹象的 `0x04` 通用强度帧；具体驱动部件以实机首次低强度测试为准。`toy_set_pattern` 控制振动花样，`toy_set_stretch` 和 `toy_set_suction` 分别使用已验证范围内的伸缩、吸吮模式。`toy_stop` 会向振动、伸缩、吸吮等已知通道都发送归零帧。

所有非零动作都必须先调用 `toy_arm_action` 获取对应动作的一次性令牌。令牌 30 秒后过期，成功使用一次后立即失效，旧会话重放或重复提交原动作时会被拒绝。建议在 Kelivo 中把 `toy_arm_action`、`toy_set_speed`、`toy_set_pattern`、`toy_set_stretch` 和 `toy_set_suction` 全部标记为“需要批准”。`toy_status`、`toy_ble_status` 是只读工具；`toy_stop` 不需要令牌，也不建议增加批准步骤，以便随时停止。

为兼容 Kelivo，设备未就绪、缺少令牌或令牌过期等安全拒绝会作为普通工具文本结果返回，并在结果 JSON 中标记 `"ok": false`；它们不会进入动作队列。这样既保持拒绝动作，又避免客户端丢失 MCP `isError` 后形成没有 `tool_result` 的 Claude 消息。

没有暴露任意十六进制写入。SL278K 的 `AE01` 在现有技术记录中没有产生控制响应；加热帧的通道索引和温控语义也尚未通过实机验证，因此这两项不会作为 MCP 写入工具出现。

## 3. 在设备附近启动电脑蓝牙中继

安装 Python 3.10+，然后安装依赖：

```bash
pip install bleak requests
```

建议升级到较新的 Bleak；Windows 连接使用 60 秒超时、指定服务过滤并绕过旧 GATT 缓存：

```powershell
python -m pip install --upgrade bleak requests
```

Windows PowerShell：

```powershell
$env:BRIDGE_URL="https://你的域名"
$env:BRIDGE_SECRET=Read-Host "粘贴与 Railway 完全相同的密钥"
python bridge.py
```

Windows 命令提示符（CMD）：

```bat
set BRIDGE_URL=https://你的域名
set BRIDGE_SECRET=与Railway完全相同的密钥
python bridge.py
```

看到“就绪！等待指令中...”后，再让 Kelivo 调用 `toy_status`；状态应显示蓝牙中继在线、设备已就绪。

### SL278K 首次连接

SL278K 会广播 `0000e0ff-...`，连接后提供 `FFE0/FFE1/FFE2` 和 `AE00/AE01/AE02`。脚本会自动识别设备名中的 `SL278K`，启用通知，然后发送该型号所需的初始化序列并立即发送所有已知停止帧。

首次运行前：

- 完全退出官方 App，并关闭附近手机蓝牙，避免设备被手机占用。
- 不要在充电时连接。
- 将设备放在稳定表面上，暂时不要佩戴或使用，并确保实体停止键随手可按。初始化序列可能造成极短暂动作。
- Windows 不要手动配对该设备；由 `bridge.py` 直接连接 BLE 广播。

看到以下内容才表示握手完成：

```text
🔐 执行 SL278K 初始化握手...
🎉 就绪！等待指令中（SL278K）...
```

新版中继还会订阅 `FFE2` 和 `AE02`，并通过 `toy_ble_status` 返回最近通知的十六进制值及距今秒数。该工具只读，不会向设备写入内容。

## 4. 安全行为

- 所有动作都有有限时长，默认 30 秒，服务端最大值默认 300 秒。
- 未检测到蓝牙设备就绪时，服务端拒绝启动动作。
- 蓝牙断开会清空当前动作，重连后不会自动恢复旧动作。
- 本地程序正常退出时会尽力向所有已知通道发送停止帧。
- 未发送的动作只有数秒有效，并且只保留最新一条，防止断线后重放。
- Railway 重启或失联时，本地 `bridge.py` 仍会按指令时长自动停止。
- `BRIDGE_SECRET` 只放 Railway Variables、Kelivo 请求头和电脑临时环境变量；不要写进仓库、URL、截图或日志。

首次动作测试必须让设备保持未佩戴/未使用状态，先用 10% 强度和 3 秒时长验证，并确保能立即使用实体按键停止。

新增动作也必须逐项测试，不要同时启动多个通道：

```text
请只调用 toy_set_stretch：模式 1、强度 10%、持续 3 秒。
```

```text
请只调用 toy_set_suction：模式 1、强度 10%、持续 3 秒。
```

每项测试结束后调用 `toy_stop`，确认完全停止再测试下一项。

## 5. 常见问题

### Kelivo 显示 401

Kelivo 请求头里的值必须完整写成：

```text
Bearer 你的BRIDGE_SECRET
```

并与 Railway 的 `BRIDGE_SECRET` 完全一致。

### Kelivo 已连接，但工具提示设备未就绪

这表示 Railway MCP 正常，但电脑端 `bridge.py` 没运行、没有连上设备，或设备被官方 App 占用。关闭其他蓝牙连接后重启 `bridge.py`。

### Railway 构建仍显示找不到启动方式

确认仓库根目录已出现 `package.json`、`package-lock.json`、`railway.json` 和 `bridge/index.js`，然后在 Railway 触发一次 Redeploy。
