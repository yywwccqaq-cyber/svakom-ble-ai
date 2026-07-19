"""
SL278H BLE 控制中继

在设备附近运行：从 Railway 安全轮询有限时长的指令，通过蓝牙发送给设备，
并每 1.5 秒续命。蓝牙断开时会清空当前动作，避免重连后意外恢复。

Windows PowerShell:
  $env:BRIDGE_URL="https://your-service.up.railway.app"
  $env:BRIDGE_SECRET="your-long-random-secret"
  python bridge.py
"""

import asyncio
import os
import time

import requests
from bleak import BleakClient, BleakScanner

WRITE_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"
H = 0x55
KEEPALIVE_SEC = 1.5
POLL_SEC = 0.3

BRIDGE_URL = os.environ.get("BRIDGE_URL", "").rstrip("/")
BRIDGE_SECRET = os.environ.get("BRIDGE_SECRET", "")
DEFAULT_DURATION_SEC = max(
    1.0, float(os.environ.get("DEFAULT_DURATION_SECONDS", "30"))
)
MAX_DURATION_SEC = max(
    DEFAULT_DURATION_SEC, float(os.environ.get("MAX_DURATION_SECONDS", "300"))
)

current_cmd = None
current_until = 0.0
client_ref = None


def log(message):
    print(message, flush=True)


def cmd_scale(value):
    value = max(0, min(255, value))
    return bytes([H, 4, 0, 0, 1, value, 0xAA])


def cmd_scale_stop():
    return bytes([H, 4, 0, 0, 0, 0, 0xAA])


def cmd_vibrate(mode, level):
    return bytes([H, 3, 0, 0, max(1, min(8, mode)), max(1, min(5, level)), 0])


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


async def write(payload):
    global client_ref
    if client_ref and client_ref.is_connected:
        try:
            await client_ref.write_gatt_char(WRITE_UUID, payload, response=False)
        except Exception as error:
            log(f"写入失败: {error}")


async def exec_cmd(command):
    global current_cmd, current_until
    if command.get("stop"):
        current_cmd = None
        current_until = 0
        await write(cmd_scale_stop())
        log("⏹ 停止")
        return

    if "pattern" in command:
        mode = int(command["pattern"])
        level = max(1, round(float(command.get("level", 0.6)) * 5))
        current_cmd = cmd_vibrate(mode, level)
        current_until = parse_duration(command)
        await write(current_cmd)
        log(f"🌀 花样 {mode} 档")
        return

    value = command_value(command)
    if value is None:
        return
    value = float(value)
    if value <= 0:
        current_cmd = None
        current_until = 0
        await write(cmd_scale_stop())
        log("⏹ 强度 0")
        return

    current_cmd = cmd_scale(int(value * 255))
    current_until = parse_duration(command)
    await write(current_cmd)
    log(f"📳 强度 {round(value * 100)}%")


async def keepalive_loop():
    global current_cmd, current_until
    while True:
        await asyncio.sleep(KEEPALIVE_SEC)
        if current_until and time.monotonic() >= current_until:
            current_cmd = None
            current_until = 0
            await write(cmd_scale_stop())
            log("⏱ 到时自动停")
            continue
        if current_cmd is not None:
            await write(current_cmd)


async def bridge_loop():
    if not BRIDGE_URL:
        log("⚠️ 未设置 BRIDGE_URL")
        return
    if len(BRIDGE_SECRET) < 24:
        log("⚠️ BRIDGE_SECRET 未设置或少于 24 个字符")
        return

    while True:
        ready = bool(client_ref and client_ref.is_connected)
        headers = {
            "x-bridge-secret": BRIDGE_SECRET,
            "x-bridge-ready": "1" if ready else "0",
        }
        try:
            response = requests.get(
                f"{BRIDGE_URL}/toy-next", headers=headers, timeout=4
            )
            if response.ok:
                command = response.json()
                if command and command.get("type") != "hello":
                    log(f"📨 {command}")
                    await exec_cmd(command)
        except Exception:
            pass
        await asyncio.sleep(POLL_SEC)


async def ble_loop():
    global client_ref, current_cmd, current_until
    while True:
        log("🔍 扫描 SL278H ...")
        devices = await BleakScanner.discover(timeout=6.0)
        device = next(
            (item for item in devices if item.name and "SL278" in item.name), None
        )
        if not device:
            log("⚠️ 没找到设备，5 秒后重试")
            await asyncio.sleep(5)
            continue

        log(f"🔗 连接 {device.name} ...")
        try:
            async with BleakClient(device) as client:
                client_ref = client
                log("🎉 就绪！等待指令中...")
                try:
                    await client.start_notify(NOTIFY_UUID, lambda _sender, _data: None)
                except Exception:
                    pass
                while client.is_connected:
                    await asyncio.sleep(1)
        except Exception as error:
            log(f"断开: {error}")
        finally:
            # Never resume a previous action after a Bluetooth reconnect.
            current_cmd = None
            current_until = 0
            client_ref = None
        await asyncio.sleep(2)


async def main():
    await asyncio.gather(bridge_loop(), ble_loop(), keepalive_loop())


if __name__ == "__main__":
    asyncio.run(main())
