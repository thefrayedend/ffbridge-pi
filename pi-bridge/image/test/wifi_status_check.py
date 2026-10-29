#!/usr/bin/env python3
"""Checks the Wi-Fi problem diagnosis, WIFI-STATUS.txt and the hotspot retry rule of ffsys.py
without a board: nmcli / iw / journalctl are faked.   python3 image/test/wifi_status_check.py"""
import importlib.util
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ffsys", os.path.join(HERE, "..", "rootfs/usr/local/lib/ffbridge/ffsys.py"))
ffsys = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ffsys)

tmp = tempfile.mkdtemp()
ffsys.STATE_DIR = tmp
ffsys.LAST_ERROR = os.path.join(tmp, "err.json")
ffsys.SCAN_CACHE = os.path.join(tmp, "scan.json")
ffsys.SETUP_DIR = os.path.join(tmp, "ffsetup")
os.makedirs(ffsys.SETUP_DIR)
ffsys.STATUS_FILE = os.path.join(ffsys.SETUP_DIR, "WIFI-STATUS.txt")
ffsys.CONFIG_FILE = os.path.join(ffsys.SETUP_DIR, "ffbridge-config.txt")

fails = 0


def check(name, cond, detail=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"  -> {detail}"))
    fails += 0 if cond else 1


# ---------------------------------------------------------------- fake system
class Fake:
    saved = ("MyHome", "secret123")      # saved Wi-Fi (ssid, psk) or None
    hotspot = True
    stations = 0
    journal = ""
    up_error = "Error: Connection activation failed: Secrets were required, but not provided."
    calls = []


def fake_run(cmd, check=False, timeout=60, input_text=None):
    Fake.calls.append(cmd)
    ok = lambda s="": subprocess.CompletedProcess(cmd, 0, s, "")  # noqa: E731
    bad = lambda e="": subprocess.CompletedProcess(cmd, 1, "", e)  # noqa: E731
    c = " ".join(cmd)
    if c.startswith("nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device"):
        w = "wlan0:wifi:connected:ffbridge-hotspot" if Fake.hotspot else "wlan0:wifi:disconnected:"
        return ok(w + "\neth0:ethernet:unavailable:\n")
    if c.startswith("nmcli -t -f DEVICE,TYPE,STATE device"):
        return ok("wlan0:wifi:connected\n")
    if c.startswith("nmcli -t -f NAME connection show --active"):
        return ok("ffbridge-hotspot\n" if Fake.hotspot else "")
    if c.startswith("nmcli -s -g"):
        return ok(f"{Fake.saved[0]}\n{Fake.saved[1]}\n") if Fake.saved else bad("no such connection")
    if c.startswith("nmcli --wait 30 connection up ffbridge-wifi"):
        return bad(Fake.up_error)
    if c.startswith("nmcli connection down ffbridge-hotspot"):
        Fake.hotspot = False
        return ok()
    if c.startswith("iw dev wlan0 station dump"):
        return ok("".join(f"Station aa:bb:cc:dd:ee:0{i} (on wlan0)\n\tinactive time: 10 ms\n" for i in range(Fake.stations)))
    if c.startswith("journalctl"):
        return ok(Fake.journal)
    if c.startswith("ip -4 -o addr show"):
        return ok("3: wlan0    inet 10.42.0.1/24 brd 10.42.0.255 scope global\n" if Fake.hotspot else "")
    return ok()


ffsys.run = fake_run
NETS = [{"ssid": "MyHome", "signal": 80}, {"ssid": "Neighbour", "signal": 30}]

# ---------------------------------------------------------------- diagnosis
p = ffsys.diagnose_wifi("MyHome", 9, NETS, None, "no-secrets")
check("wrong password from NetworkManager's log", "wrong password" in p[0] and "9 characters" in p[1], p)

p = ffsys.diagnose_wifi("myhome", 9, NETS, None, "")
check("name with wrong upper/lower case", "\"MyHome\"" in p[0] and "case" in p[1], p)

p = ffsys.diagnose_wifi("MyHom", 9, NETS, None, "")
check("name not in range / misspelled", "can't see" in p[0], p)

p = ffsys.diagnose_wifi("MyHome ", 9, NETS, None, "")
check("space at the end of the name", "space" in p[0], p)

p = ffsys.diagnose_wifi("MyHome", 5, NETS, None, "")
check("password too short", "5 characters" in p[0], p)

p = ffsys.diagnose_wifi("MyHome", 9, NETS, None, "")
check("in range, no reason known -> probably password", "wrong password" in p[0], p)

p = ffsys.diagnose_wifi("MyHome", 9, [], None, "ip-config-unavailable")
check("joined but no address from the router", "address" in p[0], p)

k, m = ffsys.explain_failure("Error: Connection activation failed: No network with SSID 'X' found.", "X")
check("nmcli 'No network with SSID' -> notfound", k == "notfound", (k, m))

# ---------------------------------------------------------------- password length check before saving
r = ffsys.wifi_configure("MyHome", "short", connect=False)
check("too-short password is refused with a clear message", not r["ok"] and "5 characters" in r["message"], r)

# ---------------------------------------------------------------- status file
ffsys.clear_wifi_error()
import json  # noqa: E402
json.dump(NETS, open(ffsys.SCAN_CACHE, "w"))
Fake.journal = "<info> device (wlan0): state change: need-auth -> failed (reason 'no-secrets', sys-iface-state: 'managed')\n"
ffsys.update_status(clients=0)
txt = open(ffsys.STATUS_FILE, newline="").read()
check("status file written with Windows line ends", "\r\n" in txt)
check("status file says NOT CONNECTED", "NOT CONNECTED" in txt, txt)
check("status file explains the wrong password", "wrong password" in txt, txt)
check("status file shows hotspot name + password", "flashforge" in txt and "10.42.0.1" in txt, txt)
check("status file lists visible networks", "\"Neighbour\"" in txt, txt)
check("status file does not contain the password itself", "secret123" not in txt, txt)
mtime = os.path.getmtime(ffsys.STATUS_FILE)
os.utime(ffsys.STATUS_FILE, (mtime - 100, mtime - 100))
ffsys.update_status(clients=0)
check("unchanged status is not rewritten (SD card wear)", os.path.getmtime(ffsys.STATUS_FILE) == mtime - 100)

Fake.saved = None
open(ffsys.CONFIG_FILE, "w").write("wifi_name=\nwifi_password=\n")
ffsys.update_status()
txt = open(ffsys.STATUS_FILE).read()
check("empty wifi_name explained", "wifi_name= in ffbridge-config.txt is empty" in txt, txt)
Fake.saved = ("MyHome", "secret123")

# ---------------------------------------------------------------- retry rule
print(ffsys.status_text(ffsys.net_status(), "MyHome", 9, "MyHome",
                        ffsys.diagnose_wifi("MyHome", 9, NETS, None, "no-secrets"), NETS))


def one_loop(stations, since_retry):
    """Runs one pass of hotspot_watch's loop; returns True when it dropped the hotspot to retry."""
    Fake.hotspot, Fake.stations, Fake.calls = True, stations, []
    clock = [1_000_000.0 - since_retry]  # first reading = when the last retry happened
    real_time, real_sleep = ffsys.time.time, ffsys.time.sleep

    def fake_time():
        t = clock[0]
        clock[0] = 1_000_000.0  # every later reading is "now"
        return t

    ffsys.time.time = fake_time

    def sleep(s):
        if s == 15:
            raise StopIteration

    ffsys.time.sleep = sleep
    orig_has = ffsys.has_network
    first = [True]

    def has_network():
        if first[0]:  # ends the 90 s start-up wait at once
            first[0] = False
            return True
        return False

    ffsys.has_network = has_network
    try:
        ffsys.hotspot_watch()
    except StopIteration:
        pass
    finally:
        ffsys.time.time, ffsys.time.sleep, ffsys.has_network = real_time, real_sleep, orig_has
    return any(c[:4] == ["nmcli", "connection", "down", "ffbridge-hotspot"] for c in Fake.calls)


check("no retry before 5 minutes", not one_loop(0, 200))
check("retry after 5 minutes when nobody is on the hotspot", one_loop(0, 310))
check("NO retry while a phone is connected to the hotspot", not one_loop(1, 310))
check("retry anyway after 30 minutes with a phone connected", one_loop(1, 1810))

print("\nall good" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
