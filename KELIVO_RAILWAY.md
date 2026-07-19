# Kelivo + Railway 部署说明

这套补充实现把项目分成两部分：

- Railway：运行标准 MCP（Streamable HTTP）和短时命令队列，不接触蓝牙。
- 设备附近的 Windows/Mac/Linux 电脑：运行 `bridge.py`，连接 SL278H 并轮询 Railway。

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

连接成功后会显示四个工具：

- `toy_status`
- `toy_set_speed`
- `toy_set_pattern`
- `toy_stop`

建议先在 Kelivo 中把 `toy_set_speed` 和 `toy_set_pattern` 标记为“需要批准”。`toy_stop` 不建议增加批准步骤，以便随时停止。

## 3. 在设备附近启动电脑蓝牙中继

安装 Python 3.10+，然后安装依赖：

```bash
pip install bleak requests
```

Windows PowerShell：

```powershell
$env:BRIDGE_URL="https://你的域名"
$env:BRIDGE_SECRET="与Railway完全相同的密钥"
python bridge.py
```

Windows 命令提示符（CMD）：

```bat
set BRIDGE_URL=https://你的域名
set BRIDGE_SECRET=与Railway完全相同的密钥
python bridge.py
```

看到“就绪！等待指令中...”后，再让 Kelivo 调用 `toy_status`；状态应显示蓝牙中继在线、设备已就绪。

## 4. 安全行为

- 所有动作都有有限时长，默认 30 秒，服务端最大值默认 300 秒。
- 未检测到蓝牙设备就绪时，服务端拒绝启动动作。
- 蓝牙断开会清空当前动作，重连后不会自动恢复旧动作。
- 未发送的动作只有数秒有效，并且只保留最新一条，防止断线后重放。
- Railway 重启或失联时，本地 `bridge.py` 仍会按指令时长自动停止。
- `BRIDGE_SECRET` 只放 Railway Variables、Kelivo 请求头和电脑临时环境变量；不要写进仓库、URL、截图或日志。

首次测试建议保持设备在手边，先用低强度和 3–5 秒时长验证，并确保能立即使用实体按键停止。

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
