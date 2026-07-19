"""只读扫描 SL278H / SL278K 的 GATT 服务与特征。"""

import asyncio
import os

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb"
ALT_SERVICE_UUID = "0000ae00-0000-1000-8000-00805f9b34fb"


def client_options():
    options = {
        "timeout": 60.0,
        "services": [SERVICE_UUID, ALT_SERVICE_UUID],
    }
    if os.name == "nt":
        options["winrt"] = {"use_cached_services": False}
    return options


async def main():
    print("🔍 扫描 SL278H / SL278K ...")
    devices = await BleakScanner.discover(timeout=12.0)
    device = next(
        (
            item
            for item in devices
            if item.name and "SL278" in item.name.upper()
        ),
        None,
    )
    if not device:
        print("⚠️ 没找到设备")
        return

    print(f"✅ 找到：{device.name}\n")
    async with BleakClient(device, **client_options()) as client:
        for service in client.services:
            print(f"[服务] {service.uuid}  {service.description}")
            for characteristic in service.characteristics:
                properties = ",".join(characteristic.properties)
                print(
                    f"    [特征] {characteristic.uuid}  "
                    f"[{properties}]  {characteristic.description}"
                )


if __name__ == "__main__":
    asyncio.run(main())
