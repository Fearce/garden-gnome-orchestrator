"""Local miIO control of a Xiaomi vacuum for GGO's Home module.

Reads one JSON request from stdin ({"action", "host", "token", "model"}) so the device token never shows up
in a process listing, and prints one JSON answer on stdout.
"""
import json
import sys
from datetime import timedelta


def answer(payload, code=0):
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(code)


def fail(message, code=1):
    answer({"ok": False, "error": message}, code)


def serialize(value):
    if isinstance(value, timedelta):
        return int(value.total_seconds())
    if hasattr(value, "name") and hasattr(value, "value"):
        return str(value.name)
    if isinstance(value, dict):
        return {str(k): serialize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [serialize(v) for v in value]
    return value


def status_payload(status):
    return {
        "state": serialize(status.state),
        "error": status.error,
        "errorCode": status.error_code,
        "battery": status.battery,
        "chargeState": serialize(status.charge_state),
        "fanSpeed": serialize(status.fan_speed),
        "waterLevel": serialize(status.water_level),
        "cleanArea": status.clean_area,
        "cleanTimeSeconds": serialize(status.clean_time),
        "consumables": {
            "mainBrush": status.main_brush_life_level,
            "sideBrush": status.side_brush_life_level,
            "filter": status.filter_life_level,
        },
    }


def main():
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        fail("The request was not valid JSON.")
    action = str(request.get("action", "")).strip().lower()
    host = str(request.get("host", "")).strip()
    token = str(request.get("token", "")).strip()
    model = str(request.get("model", "")).strip().lower() or "xiaomi-g1"
    if not host:
        fail("The vacuum's host or IP address is missing.")
    if not token:
        fail("The vacuum's miIO token is missing.")
    if model not in {"xiaomi-g1", "mijia.vacuum.v2", "xiaomi-miio"}:
        fail(f"Unsupported vacuum model '{model}'.")

    try:
        from miio.integrations.vacuum.mijia.g1vacuum import G1Vacuum
    except ImportError:
        fail("python-miio is not installed for this Python; run: pip install python-miio", 3)

    device = G1Vacuum(ip=host, token=token)
    try:
        if action == "status":
            answer({"ok": True, "status": status_payload(device.status())})
        elif action == "start":
            device.start()
        elif action == "pause":
            device.pause() if hasattr(device, "pause") else device.stop()
        elif action == "home":
            device.home()
        elif action == "find":
            device.find()
        else:
            fail(f"Unsupported action '{action}'.")
    except Exception as exc:  # python-miio raises bare DeviceException subclasses for every device error
        fail(str(exc) or exc.__class__.__name__, 2)
    answer({"ok": True})


if __name__ == "__main__":
    main()
