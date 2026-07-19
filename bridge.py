"""
SL278H / SL278K BLE 安全控制中继

在设备附近运行：从 Railway 安全轮询有限时长的指令，通过蓝牙发送给设备。
蓝牙断开、程序退出或指令到时都会清空当前动作，避免重连后恢复旧动作。

Windows PowerShell:
  $env:BRIDGE_URL="https://your-service.up.railway.app"
  $env:BRIDGE_SECRET=Read-Host "Paste BRIDGE_SECRET"
  python bridge.py
"""

import asyncio
import os
import time

import requests
from bleak import BleakClient, BleakScanner

SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb"
ALT_SERVICE_UUID = "0000ae00-0000-1000-8000-00805f9b34fb"
WRITE_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"
ALT_NOTIFY_UUID = "0000ae02-0000-1000-8000-00805f9b34fb"

PROFILE_SL278H = "sl278h"
PROFILE_SL278K = "sl278k"

H = 0x55
KEEPALIVE_SEC = 1.5
POLL_SEC = 0.3
SCAN_TIMEOUT_SEC = 12.0
CONNECT_TIMEOUT_SEC = 60.0

# The official SL278K app sends this neutralizing initialization sequence about
# 240 ms after connecting. It is required before normal control packets work.
SL278K_INIT_FRAMES = (
    bytes([H, 0x04, 0x00, 0x00, 0x01, 0xFF, 0xAA]),
    bytes([H, 0x04, 0x00, 0x00, 0x00, 0x00, 0xAA]),
    bytes([H, 0x04, 0x00, 0x00, 0x00, 0x00, 0xAA]),
    bytes([H, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00]),
)

BRIDGE_URL = os.environ.get("BRIDGE_URL", "").rstrip("/")
BRIDGE_SECRET = os.environ.get("BRIDGE_SECRET", "")
DEFAULT_DURATION_SEC = max(
    1.0, float(os.environ.get("DEFAULT_DURATION_SECONDS", "30"))
)
MAX_DURATION_SEC = max(
    DEFAULT_DURATION_SEC, float(os.environ.get("MAX_DURATION_SECONDS", "300"))
)

current_frames = None
current_until = 0.0
client_ref = None
device_profile = None
last_notifications = {"ffe2": None, "ae02": None}


def log(message):
    print(message, flush=True)


def detect_profile(device_name):
    normalized = str(device_name or "").upper()
    return PROFILE_SL278K if "SL278K" in normalized else PROFILE_SL278H


def cmd_scale(value):
    value = max(0, min(255, int(value)))
    return bytes([H, 0x04, 0x00, 0x00, 0x01, value, 0xAA])


def cmd_scale_stop():
    return bytes([H, 0x04, 0x00, 0x00, 0x00, 0x00, 0xAA])


def cmd_mode(opcode, mode, strength, *, max_mode, max_strength):
    mode = max(1, min(max_mode, int(mode)))
    strength = max(1, min(max_strength, int(strength)))
    return bytes([H, opcode, 0x00, 0x00, mode, strength, 0x00])


def cmd_mode_stop(opcode):
    return bytes([H, opcode, 0x00, 0x00, 0x00, 0x00, 0x00])


def stop_frames(profile):
    # Send every relevant neutral frame. Unsupported opcodes are ignored by the
    # device, while this makes stop robust across SL278H and SL278K actuators.
    frames = [cmd_scale_stop(), cmd_mode_stop(0x03)]
    if profile == PROFILE_SL278K:
        frames.extend((cmd_mode_stop(0x08), cmd_mode_stop(0x09)))
    return tuple(frames)


def profile_capabilities(profile):
    if profile == PROFILE_SL278K:
        return ("vibration", "stretch", "suction")
    return ("vibration",)


def parse_duration(command):
    seconds = DEFAULT_DURATION_SEC
    for key in ("sec", "seconds", "duration"):
        if key in command:
            seconds = float(command[key])
            break
    seconds = max(0.1, min(MAX_DURATION_SEC, seconds))
    return time.monotonic() + seconds


def command_value(command):
    for key in ("speed", "suck", "intensity"):
        if key in command:
            return command[key]
    return None


def action_frames(command, profile):
    action = str(command.get("action", "")).lower()
    if action in {"vibration", "stretch", "suction"}:
        opcode, max_mode = {
            "vibration": (0x03, 10 if profile == PROFILE_SL278K else 8),
            "stretch": (0x08, 7),
            "suction": (0x09, 5),
        }[action]
        if action != "vibration" and profile != PROFILE_SL278K:
            return ()
        strength = round(float(command.get("level", 0.3)) * 10)
        return (
            cmd_mode(
                opcode,
                command.get("mode", 1),
                strength,
                max_mode=max_mode,
                max_strength=10,
            ),
        )

    if "pattern" in command:
        max_mode = 10 if profile == PROFILE_SL278K else 8
        max_strength = 10 if profile == PROFILE_SL278K else 5
        strength = round(float(command.get("level", 0.6)) * max_strength)
        return (
            cmd_mode(
                0x03,
                command["pattern"],
                strength,
                max_mode=max_mode,
                max_strength=max_strength,
            ),
        )

    value = command_value(command)
    if value is None:
        return ()
    value = max(0.0, min(1.0, float(value)))
    if value <= 0:
        return stop_frames(profile)
    if profile == PROFILE_SL278K:
        # For the K profile, the existing generic speed tool controls vibration
        # mode 1 at a 1..10 strength. Stretch/suction are intentionally not
        # activated by this generic command.
        return (
            cmd_mode(
                0x03,
                1,
                round(value * 10),
                max_mode=10,
                max_strength=10,
            ),
        )
    return (cmd_scale(int(value * 255)),)


async def write_frame(payload, *, client=None):
    target = client or client_ref
    if not target or not target.is_connected:
        return False
    try:
        await target.write_gatt_char(WRITE_UUID, payload, response=False)
        return True
    except Exception as error:
        log(f"写入失败: {error}")
        return False


async def write_frames(frames, *, client=None, pause=0.04):
    wrote_all = True
    for index, payload in enumerate(frames):
        wrote_all = (await write_frame(payload, client=client)) and wrote_all
        if pause and index + 1 < len(frames):
            await asyncio.sleep(pause)
    return wrote_all


def notification_handler(channel):
    def handle(_sender, data):
        last_notifications[channel] = {
            "hex": bytes(data).hex()[:128],
            "at": time.monotonic(),
        }

    return handle


def notification_headers():
    headers = {}
    now = time.monotonic()
    for channel, entry in last_notifications.items():
        if not entry:
            continue
        headers[f"x-bridge-{channel}"] = entry["hex"]
        headers[f"x-bridge-{channel}-age-ms"] = str(
            max(0, round((now - entry["at"]) * 1_000))
        )
    return headers


async def initialize_sl278k(client):
    # Notifications are enabled first so acknowledgements are not missed.
    try:
        await client.start_notify(NOTIFY_UUID, notification_handler("ffe2"))
    except Exception as error:
        log(f"⚠️ 通知启用失败，将继续尝试握手: {error}")
    await asyncio.sleep(0.24)
    if not await write_frames(SL278K_INIT_FRAMES, client=client, pause=0.04):
        raise RuntimeError("SL278K 初始化握手写入失败")
    # End initialization in an explicitly neutral state.
    await write_frames(stop_frames(PROFILE_SL278K), client=client, pause=0.02)
    try:
        await client.start_notify(ALT_NOTIFY_UUID, notification_handler("ae02"))
    except Exception as error:
        log(f"⚠️ AE02 通知启用失败，只读状态将缺少该通道: {error}")


async def exec_cmd(command):
    global current_frames, current_until
    profile = device_profile or PROFILE_SL278H
    if command.get("stop"):
        current_frames = None
        current_until = 0
        await write_frames(stop_frames(profile))
        log("⏹ 已发送全功能停止")
        return

    frames = action_frames(command, profile)
    if not frames:
        return
    if command_value(command) is not None and float(command_value(command)) <= 0:
        current_frames = None
        current_until = 0
        await write_frames(frames)
        log("⏹ 强度 0")
        return

    if not await write_frames(frames):
        current_frames = None
        current_until = 0
        log("⚠️ 动作写入失败，未保持该动作")
        return
    current_frames = frames
    current_until = parse_duration(command)
    if "pattern" in command:
        log(
            f"🌀 振动花样 {int(command['pattern'])}，强度 "
            f"{round(float(command.get('level', 0.6)) * 100)}%"
        )
    elif command.get("action"):
        labels = {
            "vibration": "振动",
            "stretch": "伸缩",
            "suction": "吸吮",
        }
        action = str(command["action"]).lower()
        log(
            f"🧩 {labels.get(action, action)}模式 {int(command.get('mode', 1))}，"
            f"强度 {round(float(command.get('level', 0.3)) * 100)}%"
        )
    else:
        log(f"📳 振动强度 {round(float(command_value(command)) * 100)}%")


async def keepalive_loop():
    global current_frames, current_until
    while True:
        await asyncio.sleep(KEEPALIVE_SEC)
        if current_until and time.monotonic() >= current_until:
            current_frames = None
            current_until = 0
            await write_frames(stop_frames(device_profile or PROFILE_SL278H))
            log("⏱ 到时自动停")
            continue
        if current_frames is not None:
            await write_frames(current_frames)


async def bridge_loop():
    if not BRIDGE_URL:
        log("⚠️ 未设置 BRIDGE_URL")
        return
    if len(BRIDGE_SECRET) < 24:
        log("⚠️ BRIDGE_SECRET 未设置或少于 24 个字符")
        return

    while True:
        ready = bool(client_ref and client_ref.is_connected and device_profile)
        headers = {
            "x-bridge-secret": BRIDGE_SECRET,
            "x-bridge-ready": "1" if ready else "0",
        }
        if ready:
            headers["x-bridge-profile"] = device_profile
            headers["x-bridge-capabilities"] = ",".join(
                profile_capabilities(device_profile)
            )
            headers.update(notification_headers())
        try:
            response = await asyncio.to_thread(
                requests.get,
                f"{BRIDGE_URL}/toy-next",
                headers=headers,
                timeout=4,
            )
            if response.ok:
                command = response.json()
                if command and command.get("type") != "hello":
                    log(f"📨 {command}")
                    await exec_cmd(command)
        except Exception:
            pass
        await asyncio.sleep(POLL_SEC)


def client_options():
    options = {
        "timeout": CONNECT_TIMEOUT_SEC,
        "services": [SERVICE_UUID, ALT_SERVICE_UUID],
    }
    if os.name == "nt":
        options["winrt"] = {"use_cached_services": False}
    return options


async def ble_loop():
    global client_ref, current_frames, current_until, device_profile
    while True:
        log("🔍 扫描 SL278H / SL278K ...")
        devices = await BleakScanner.discover(timeout=SCAN_TIMEOUT_SEC)
        device = next(
            (item for item in devices if item.name and "SL278" in item.name.upper()),
            None,
        )
        if not device:
            log("⚠️ 没找到设备，5 秒后重试")
            await asyncio.sleep(5)
            continue

        profile = detect_profile(device.name)
        log(f"🔗 连接 {device.name}（{profile.upper()}）...")
        try:
            async with BleakClient(device, **client_options()) as client:
                if profile == PROFILE_SL278K:
                    log("🔐 执行 SL278K 初始化握手...")
                    await initialize_sl278k(client)
                else:
                    try:
                        await client.start_notify(
                            NOTIFY_UUID, notification_handler("ffe2")
                        )
                    except Exception:
                        pass

                client_ref = client
                device_profile = profile
                log(f"🎉 就绪！等待指令中（{device.name}）...")
                try:
                    while client.is_connected:
                        await asyncio.sleep(1)
                finally:
                    # Best effort neutralization before a graceful local exit.
                    if client.is_connected:
                        await write_frames(stop_frames(profile), client=client)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            log(f"断开: {error}")
        finally:
            # Never resume a previous action after a Bluetooth reconnect.
            current_frames = None
            current_until = 0
            client_ref = None
            device_profile = None
        await asyncio.sleep(2)


async def main():
    await asyncio.gather(bridge_loop(), ble_loop(), keepalive_loop())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log("\n已退出。")
