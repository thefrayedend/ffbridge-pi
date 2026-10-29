#!/usr/bin/env python3
"""Printer network (router mode) helper logic: settings checks, internet timer, firewall rules.
(The firewall itself was also tested in network namespaces: printers blocked / allowed.)
    python3 image/test/printernet_check.py"""
import importlib.util
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ffsys", os.path.join(HERE, "..", "rootfs/usr/local/lib/ffbridge/ffsys.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
tmp = tempfile.mkdtemp()
m.STATE_DIR = tmp
m.PRINTERNET_FILE = os.path.join(tmp, "printer-network.json")
fails = 0


def check(name, cond, detail=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"  -> {detail}"))
    fails += 0 if cond else 1


calls = []
fake = {"eth": "192.168.1.20", "wifi": "wlan0"}


def fake_run(cmd, check=False, timeout=60, input_text=None):
    calls.append(cmd)
    out = ""
    if cmd[:4] == ["nmcli", "-t", "-f", "DEVICE,TYPE,STATE"]:
        out = (f"{fake['wifi']}:wifi:disconnected\n" if fake["wifi"] else "") + ("eth0:ethernet:connected\n" if fake["eth"] else "")
    elif cmd[:3] == ["ip", "-4", "-o"]:
        out = f"2: eth0    inet {fake['eth']}/24 brd x" if fake["eth"] else ""
    return subprocess.CompletedProcess(cmd, 0, out, "")


m.run = fake_run
m.wifi_device = lambda: fake["wifi"]

# --- defaults
st = m.printernet_state()
check("off by default", st["enabled"] is False and st["internetUntil"] == 0)
check("internet blocked by default", m.internet_allowed(st) is False)

# --- enable: input checks
check("needs a password", m.printernet_enable("Printers", "")["ok"] is False)
check("password too short refused", "8 to 63" in m.printernet_enable("Printers", "short")["message"])
check("name too long refused", m.printernet_enable("x" * 33, "longenough1")["ok"] is False)
fake["eth"] = ""
r = m.printernet_enable("Printers", "longenough1")
check("refuses without the network cable (board would drop off the home network)", r["ok"] is False and "cable" in r["message"], r)
check("nothing switched on when refused", m.printernet_state()["enabled"] is False)
fake["eth"] = "192.168.1.20"
fake["wifi"] = None
check("refuses without Wi-Fi hardware", m.printernet_enable("Printers", "longenough1")["ok"] is False)
fake["wifi"] = "wlan0"

calls.clear()
r = m.printernet_enable("Printers", "longenough1")
check("enables with cable + valid settings", r["ok"] and m.printernet_state()["enabled"], r)
check("restarts the watcher to switch mode", ["systemctl", "restart", "ffbridge-hotspot"] in calls)
check("password file is private (0600)", oct(os.stat(m.PRINTERNET_FILE).st_mode & 0o777) == "0o600")
r = m.printernet_enable("Printers 2", "")
check("re-saving without a password keeps the old one", r["ok"] and m.printernet_state()["password"] == "longenough1", r)

# --- internet timer (firewall call stubbed out)
m.printernet_firewall = lambda dev, allow: ""
m.printernet_internet(60)
st = m.printernet_state()
check("allow for 60 min", m.internet_allowed(st) and 3500 < st["internetUntil"] - time.time() <= 3600)
check("switches itself off when the time is up", m.internet_allowed(st, now=st["internetUntil"] + 1) is False)
m.printernet_internet(-1)
check("until turned off", m.internet_allowed(m.printernet_state(), now=time.time() + 10 ** 8))
m.printernet_internet(0)
check("block again", m.internet_allowed(m.printernet_state()) is False)

# --- firewall rules
off, on = m.nft_rules("wlan0", False), m.nft_rules("wlan0", True)
check("blocked: printers' traffic dropped, no NAT", 'iifname "wlan0" drop' in off and "masquerade" not in off)
check("allowed: passed on + NAT", 'iifname "wlan0" accept' in on and "masquerade" in on)
check("rules replace the old ones (no stacking)", off.startswith("table ip ffbridge_printers\ndelete table ip ffbridge_printers\n"))

# --- disable
calls.clear()
m.saved_wifi = lambda: ("HomeWiFi", 12)
r = m.printernet_disable()
check("disable switches it off", r["ok"] and not m.printernet_state()["enabled"])
check("home Wi-Fi switched back on", ["nmcli", "connection", "modify", m.WIFI_CON, "connection.autoconnect", "yes"] in calls)
check("printer Wi-Fi removed", ["nmcli", "connection", "delete", m.PRINTERNET_CON] in calls)

# --- leases
m.PRINTERNET_LEASES = os.path.join(tmp, "leases")
open(m.PRINTERNET_LEASES, "w").write("1793300000 aa:bb:cc:dd:ee:ff 10.43.0.61 Creator5 01:aa\n1793300001 11:22:33:44:55:66 10.43.0.62 * *\n")
ls = m.printernet_leases()
check("connected printers listed", [l["ip"] for l in ls] == ["10.43.0.61", "10.43.0.62"] and ls[0]["name"] == "Creator5" and ls[1]["name"] == "", ls)

print("\nall good" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
