"""SL278H / SL278K 控制面只读 GATT 与通知采集器。

本脚本不会调用 write_gatt_char，也不会向 FFE1/AE01 发送控制帧。
启用 notify/indicate 时，BLE 栈会写入标准 CCCD 描述符；这只用于订阅通知，
不写厂商控制特征，也不会由脚本启动振动、伸缩、吸吮或加热。
"""

import asyncio
import hashlib
import json
import os
import time
from pathlib import Path

from bleak import BleakClient, BleakScanner

SCAN_TIMEOUT_SECONDS = 12.0
CONNECT_TIMEOUT_SECONDS = 60.0
BASELINE_SECONDS = 5
ACTION_OBSERVE_SECONDS = 12
REPORT_PATH = Path("gatt_report.json")


def client_options():
    # 不使用 services 过滤器：温控若位于其他服务，也必须完整枚举出来。
    options = {"timeout": CONNECT_TIMEOUT_SECONDS}
    if os.name == "nt":
        options["winrt"] = {"use_cached_services": False}
    return options


def anonymized_device_id(address):
    value = str(address or "unknown").encode("utf-8")
    return hashlib.sha256(value).hexdigest()[:12]


def hex_value(value, limit=256):
    return bytes(value).hex()[:limit]


async def observe(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        await asyncio.sleep(max(0.0, min(1.0, deadline - time.monotonic())))


async def main():
    print("🔍 扫描 SL278H / SL278K ...", flush=True)
    devices = await BleakScanner.discover(timeout=SCAN_TIMEOUT_SECONDS)
    device = next(
        (item for item in devices if item.name and "SL278" in item.name.upper()),
        None,
    )
    if not device:
        print("⚠️ 没找到设备", flush=True)
        return

    report = {
        "schema": 1,
        "device_name": device.name,
        "device_id": anonymized_device_id(device.address),
        "control_characteristic_writes": 0,
        "services": [],
        "events": [],
        "markers": [],
    }
    started_at = time.monotonic()

    def marker(label):
        entry = {
            "label": label,
            "elapsed_ms": round((time.monotonic() - started_at) * 1000),
        }
        report["markers"].append(entry)
        print(f"\n--- {label} ---", flush=True)

    def notification_handler(uuid):
        def handle(_sender, data):
            entry = {
                "uuid": str(uuid).lower(),
                "hex": hex_value(data),
                "elapsed_ms": round((time.monotonic() - started_at) * 1000),
            }
            report["events"].append(entry)
            print(
                f"[通知 +{entry['elapsed_ms']}ms] {entry['uuid']} = {entry['hex']}",
                flush=True,
            )

        return handle

    print(f"✅ 找到：{device.name}（匿名编号 {report['device_id']}）", flush=True)
    print("🔒 不会向 FFE1/AE01 或其他控制特征写入数据。", flush=True)

    subscribed = []
    async with BleakClient(device, **client_options()) as client:
        for service in client.services:
            service_entry = {
                "uuid": service.uuid.lower(),
                "description": service.description,
                "characteristics": [],
            }
            report["services"].append(service_entry)
            print(f"\n[服务] {service.uuid}  {service.description}", flush=True)

            for characteristic in service.characteristics:
                properties = sorted(characteristic.properties)
                characteristic_entry = {
                    "uuid": characteristic.uuid.lower(),
                    "handle": characteristic.handle,
                    "description": characteristic.description,
                    "properties": properties,
                    "read": None,
                    "read_error": None,
                    "descriptors": [],
                }
                service_entry["characteristics"].append(characteristic_entry)
                print(
                    f"    [特征] {characteristic.uuid} [{','.join(properties)}] "
                    f"handle={characteristic.handle} {characteristic.description}",
                    flush=True,
                )

                if "read" in properties:
                    try:
                        value = await client.read_gatt_char(characteristic)
                        characteristic_entry["read"] = hex_value(value)
                        print(
                            f"        [只读值] {characteristic_entry['read']}",
                            flush=True,
                        )
                    except Exception as error:
                        characteristic_entry["read_error"] = type(error).__name__
                        print(
                            f"        [读取失败] {type(error).__name__}: {error}",
                            flush=True,
                        )

                for descriptor in characteristic.descriptors:
                    descriptor_entry = {
                        "uuid": descriptor.uuid.lower(),
                        "handle": descriptor.handle,
                        "description": descriptor.description,
                        "read": None,
                        "read_error": None,
                    }
                    characteristic_entry["descriptors"].append(descriptor_entry)
                    try:
                        value = await client.read_gatt_descriptor(descriptor.handle)
                        descriptor_entry["read"] = hex_value(value)
                    except Exception as error:
                        descriptor_entry["read_error"] = type(error).__name__

                if "notify" in properties or "indicate" in properties:
                    try:
                        await client.start_notify(
                            characteristic,
                            notification_handler(characteristic.uuid),
                        )
                        subscribed.append(characteristic)
                        print("        [已订阅通知]", flush=True)
                    except Exception as error:
                        print(
                            f"        [通知订阅失败] {type(error).__name__}: {error}",
                            flush=True,
                        )

        marker("静置基线开始")
        print(f"保持不操作 {BASELINE_SECONDS} 秒。", flush=True)
        await observe(BASELINE_SECONDS)

        marker("实体加热键开启观察开始")
        await asyncio.to_thread(
            input,
            "设备不要佩戴或使用；若有实体加热键，请按一次开启，然后按 Enter：",
        )
        marker("用户报告已按开启")
        await observe(ACTION_OBSERVE_SECONDS)

        marker("实体加热键关闭观察开始")
        await asyncio.to_thread(
            input,
            "现在按同一个实体键关闭加热，然后按 Enter：",
        )
        marker("用户报告已按关闭")
        await observe(ACTION_OBSERVE_SECONDS)

        for characteristic in subscribed:
            try:
                await client.stop_notify(characteristic)
            except Exception:
                pass

    REPORT_PATH.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\n✅ 已保存只读报告：{REPORT_PATH.resolve()}", flush=True)
    print("把 gatt_report.json 发给哥哥；不要发送 BRIDGE_SECRET。", flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n已退出。", flush=True)
