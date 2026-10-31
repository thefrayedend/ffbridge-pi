#!/usr/bin/env python3
"""
FlashForge Pi Bridge - system helper (runs as root).

Sub-commands used by systemd units:
  firstboot        grow the root partition to fill the SD card (once)
  apply-config     apply Wi-Fi / hostname / SSH settings from the SD card's ffbridge-config.txt
  hotspot-watch    start a setup Wi-Fi hotspot when the board has no network (long-running)

Sub-commands used by the bridge's setup page (via `sudo ffbridge-helper <cmd>`), all print JSON:
  net-status | wifi-scan | wifi-connect <ssid> (password on stdin) | wifi-forget
  set-hostname <name> | reboot | shutdown | restart-ai | system-info
  printernet-status | printernet-enable <ssid> (password on stdin) | printernet-disable
  printernet-internet <minutes, 0 = block, -1 = until turned off>
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time

SETUP_DIR = "/ffsetup"
CONFIG_FILE = os.path.join(SETUP_DIR, "ffbridge-config.txt")
STATE_DIR = "/var/lib/ffbridge-sys"
WIFI_CON = "ffbridge-wifi"
HOTSPOT_CON = "ffbridge-hotspot"
HOTSPOT_PASSWORD = "flashforge"
SCAN_CACHE = os.path.join(STATE_DIR, "wifi-scan.json")
LAST_ERROR = os.path.join(STATE_DIR, "wifi-last-error.json")
STATUS_FILE = os.path.join(SETUP_DIR, "WIFI-STATUS.txt")
ADMIN_USER = "ffadmin"
RETRY_EVERY = 300        # retry the saved Wi-Fi every 5 min while the setup hotspot is on ...
MAX_DEFER = 1800         # ... but not while a phone is connected to the hotspot (at most 30 min)



# ----------------------------------------------------------------------------- slicer helpers
AI_PAUSE_MARK = "/run/ffbridge-ai-paused"


def ai_pause():
    """Stops the AI service while the slicer runs (frees its memory and CPU). Only marks it for
    resuming when it was running, so a service the user switched off stays off."""
    if run(["systemctl", "is-active", "--quiet", "ffai"]).returncode != 0:
        return {"ok": True, "message": "AI service was not running."}
    open(AI_PAUSE_MARK, "w").close()
    r = run(["systemctl", "stop", "ffai"], timeout=30)
    return {"ok": r.returncode == 0, "message": "AI service paused." if r.returncode == 0 else r.stderr.strip()}


def ai_resume():
    if not os.path.exists(AI_PAUSE_MARK):
        return {"ok": True, "message": "AI service was not paused."}
    os.remove(AI_PAUSE_MARK)
    r = run(["systemctl", "start", "--no-block", "ffai"])
    return {"ok": r.returncode == 0, "message": "AI service started again." if r.returncode == 0 else r.stderr.strip()}


def zram_setup():
    """Compressed swap in RAM (zstd, half the memory): big slices squeeze into it instead of
    the out-of-memory killer stopping them. Nothing is written to the SD card. Safe to repeat."""
    try:
        if "/dev/zram0" in open("/proc/swaps").read():
            return {"ok": True, "message": "zram swap already on."}
        mem_kb = int(next(l for l in open("/proc/meminfo") if l.startswith("MemTotal")).split()[1])
        run(["modprobe", "zram"])
        if not os.path.exists("/sys/block/zram0"):
            return {"ok": False, "message": "This kernel has no zram."}
        def put(path, value):
            with open(path, "w") as f:
                f.write(value)
        for alg in ("zstd", "lz4", "lzo-rle"):
            try:
                put("/sys/block/zram0/comp_algorithm", alg)
                break
            except OSError:
                pass
        put("/sys/block/zram0/disksize", str(mem_kb // 2 * 1024))
        run(["mkswap", "/dev/zram0"], check=True)
        run(["swapon", "-p", "100", "/dev/zram0"], check=True)
        put("/proc/sys/vm/swappiness", "100")
        return {"ok": True, "message": f"zram swap on ({mem_kb // 2 // 1024} MB)."}
    except Exception as e:  # noqa: BLE001 - report, never break the bridge start
        return {"ok": False, "message": f"zram swap not set up: {e}"}

# ----------------------------------------------------------------------------- helpers
def run(cmd, check=False, timeout=60, input_text=None):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, input=input_text)
    except (OSError, subprocess.TimeoutExpired) as e:
        if check:
            raise
        return subprocess.CompletedProcess(cmd, 1, "", str(e))
    if check and r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip() or f"{cmd[0]} failed")
    return r


def log(msg):
    print(f"ffbridge: {msg}", file=sys.stderr, flush=True)


def out(obj):
    print(json.dumps(obj))


def nm_fields(line):
    """Split nmcli -t output (':' separated, '\\:' escaped)."""
    return [p.replace("\\:", ":") for p in re.split(r"(?<!\\):", line)]


def parse_config(path=CONFIG_FILE):
    cfg = {}
    try:
        with open(path, encoding="utf-8-sig", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line[0] in "#;[" or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                cfg[k.strip().lower()] = v
    except FileNotFoundError:
        pass
    return cfg


def truthy(v):
    return str(v).strip().lower() in ("1", "yes", "y", "on", "true", "enable", "enabled")


def wifi_device():
    r = run(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device"])
    for line in r.stdout.splitlines():
        f = nm_fields(line)
        if len(f) >= 2 and f[1] == "wifi" and not f[0].startswith("p2p"):
            return f[0]
    return None


def ipv4_of(dev):
    r = run(["ip", "-4", "-o", "addr", "show", "dev", dev])
    m = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", r.stdout)
    return m.group(1) if m else ""


def hotspot_active():
    r = run(["nmcli", "-t", "-f", "NAME", "connection", "show", "--active"])
    return HOTSPOT_CON in r.stdout.splitlines()


def has_network():
    """True when ethernet or a normal Wi-Fi connection has an IPv4 address (not the hotspot)."""
    r = run(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device"])
    for line in r.stdout.splitlines():
        f = nm_fields(line)
        if len(f) < 4 or f[1] not in ("ethernet", "wifi") or not f[2].startswith("connected"):
            continue
        if f[3] == HOTSPOT_CON:
            continue
        ip = ipv4_of(f[0])
        if ip and not ip.startswith("10.42.") and not ip.startswith("169.254."):
            return True
    return False


def hotspot_ssid():
    try:
        dev = wifi_device()
        mac = open(f"/sys/class/net/{dev}/address").read().strip().replace(":", "") if dev else ""
    except OSError:
        mac = ""
    return "FlashForge-Bridge-" + (mac[-4:].upper() if mac else "Setup")


# ----------------------------------------------------------------------------- first boot
def firstboot():
    os.makedirs(STATE_DIR, exist_ok=True)
    marker = os.path.join(STATE_DIR, "firstboot.done")
    if os.path.exists(marker):
        return
    try:
        src = run(["findmnt", "-n", "-o", "SOURCE", "/"]).stdout.strip()  # e.g. /dev/mmcblk0p1
        m = re.match(r"(/dev/(?:mmcblk\d+|nvme\d+n\d+|sd[a-z]+))p?(\d+)$", src)
        if m:
            disk, part = m.group(1), m.group(2)
            log(f"growing {src} to fill {disk}")
            run(["sfdisk", "--no-reread", "--no-tell-kernel", "-N", part, disk], input_text=", +\n")
            r = run(["partx", "-u", "--nr", part, disk])
            if r.returncode != 0:
                run(["resizepart", disk, part, str(int(run(["sfdisk", "--show-size", src]).stdout.strip() or 0))])
            run(["resize2fs", src], timeout=600)
        else:
            log(f"root device {src} not recognised, not resizing")
    except Exception as e:  # noqa: BLE001
        log(f"resize failed: {e}")
    # fresh SSH host keys per board
    if os.path.isdir("/etc/ssh"):
        for f in os.listdir("/etc/ssh"):
            if f.startswith("ssh_host_"):
                os.remove(os.path.join("/etc/ssh", f))
        run(["ssh-keygen", "-A"])
    # machine-id must be unique per board (DHCP client id, mDNS)
    try:
        if os.path.getsize("/etc/machine-id") == 0 or open("/etc/machine-id").read().strip() in ("", "uninitialized"):
            run(["systemd-machine-id-setup"])
    except OSError:
        run(["systemd-machine-id-setup"])
    open(marker, "w").write(time.strftime("%Y-%m-%d %H:%M:%S\n"))


# ----------------------------------------------------------------------------- SD card config
def apply_config():
    os.makedirs(STATE_DIR, exist_ok=True)
    cfg = parse_config()
    if not cfg:
        log("no ffbridge-config.txt settings found")
        return
    fingerprint = hashlib.sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest()
    stamp = os.path.join(STATE_DIR, "config.sha256")
    if os.path.exists(stamp) and open(stamp).read().strip() == fingerprint:
        log("ffbridge-config.txt unchanged")
        return

    hostname = re.sub(r"[^a-z0-9-]", "", cfg.get("hostname", "").lower())[:32]
    if hostname:
        set_hostname(hostname)

    country = cfg.get("wifi_country", "").upper()
    if re.fullmatch(r"[A-Z]{2}", country):
        run(["iw", "reg", "set", country])
        try:
            with open("/etc/default/crda", "w") as f:
                f.write(f"REGDOMAIN={country}\n")
        except OSError:
            pass

    complete = True
    ssid = cfg.get("wifi_name") or cfg.get("wifi_ssid") or ""
    if ssid:
        for _ in range(30):  # the Wi-Fi driver can show up a little after NetworkManager
            if wifi_device():
                break
            time.sleep(1)
        r = wifi_configure(ssid, cfg.get("wifi_password", ""), hidden=truthy(cfg.get("wifi_hidden", "no")), connect=False)
        log(r.get("message", ""))
        if r.get("ok"):
            clear_wifi_error()  # new details: forget the previous attempt's problem
        complete = r.get("ok", False)

    tz = cfg.get("timezone", "")
    if tz and os.path.exists(f"/usr/share/zoneinfo/{tz}"):
        run(["timedatectl", "set-timezone", tz])

    ssh_pw = cfg.get("ssh_password", "")
    if truthy(cfg.get("ssh", "no")) and len(ssh_pw) >= 6:
        if run(["id", ADMIN_USER]).returncode != 0:
            run(["useradd", "-m", "-s", "/bin/bash", "-G", "sudo", ADMIN_USER])
        run(["chpasswd"], input_text=f"{ADMIN_USER}:{ssh_pw}\n")
        run(["systemctl", "enable", "--now", "ssh"])
        log(f"SSH enabled for user {ADMIN_USER}")
    elif "ssh" in cfg and not truthy(cfg.get("ssh")):
        run(["systemctl", "disable", "--now", "ssh"])

    if complete:  # otherwise try again on the next boot
        with open(stamp, "w") as f:
            f.write(fingerprint)


# ----------------------------------------------------------------------------- Wi-Fi
def wifi_configure(ssid, password, hidden=False, connect=True, timeout=45):
    dev = wifi_device()
    if not dev:
        save_wifi_error(ssid, "nohw", "No Wi-Fi hardware found on this board.")
        return {"ok": False, "message": "No Wi-Fi hardware found on this board."}
    if password and not (8 <= len(password) <= 63 or re.fullmatch(r"[0-9a-fA-F]{64}", password)):
        msg = (f"The Wi-Fi password has {len(password)} characters. Wi-Fi passwords are 8 to 63 characters long, "
               "so it must be mistyped.")
        save_wifi_error(ssid, "password", msg)
        return {"ok": False, "message": msg}
    run(["nmcli", "radio", "wifi", "on"])
    run(["nmcli", "connection", "delete", WIFI_CON])
    args = ["nmcli", "connection", "add", "type", "wifi", "con-name", WIFI_CON, "ifname", dev, "ssid", ssid,
            "connection.autoconnect", "yes", "connection.autoconnect-priority", "10", "802-11-wireless.powersave", "2"]
    if hidden:
        args += ["802-11-wireless.hidden", "yes"]
    if password:
        args += ["wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", password]
    r = run(args)
    if r.returncode != 0:
        msg = "Could not save the Wi-Fi settings: " + (r.stderr or r.stdout).strip()
        save_wifi_error(ssid, "save", msg)
        return {"ok": False, "message": msg}
    if printernet_state()["enabled"]:  # the Wi-Fi is busy as the printer network: keep the details for later
        run(["nmcli", "connection", "modify", WIFI_CON, "connection.autoconnect", "no"])
        return {"ok": True, "message": f"Wi-Fi \"{ssid}\" saved. It will be used when printer network mode is switched off."}
    if not connect:
        return {"ok": True, "message": f"Wi-Fi \"{ssid}\" saved."}
    was_hotspot = hotspot_active()
    if was_hotspot:
        run(["nmcli", "connection", "down", HOTSPOT_CON])
        time.sleep(2)
    r = run(["nmcli", "--wait", str(timeout), "connection", "up", WIFI_CON], timeout=timeout + 15)
    if r.returncode == 0:
        time.sleep(2)
        clear_wifi_error()
        return {"ok": True, "message": f"Connected to \"{ssid}\" ({ipv4_of(dev) or 'getting an address'}).", "ip": ipv4_of(dev)}
    kind, msg = explain_failure((r.stderr or r.stdout).strip(), ssid)
    save_wifi_error(ssid, kind, msg)
    if was_hotspot:
        start_hotspot()
    return {"ok": False, "message": "Could not connect: " + msg}


# ----------------------------------------------------------------------------- Wi-Fi problems
# Why the saved Wi-Fi didn't connect, in words a beginner understands. The reason comes from
# nmcli's error text or NetworkManager's log; the Wi-Fi scan tells "name not found" apart.
def explain_failure(text, ssid=""):
    t = (text or "").lower()
    if any(k in t for k in ("secrets were required", "no-secrets", "supplicant-disconnect", "need-auth", "802-1x", "psk")):
        return "password", "The Wi-Fi password was rejected (wrong password)."
    if "supplicant-timeout" in t:
        return "password", ("The router didn't accept the board. Usually that's a wrong password; "
                            "sometimes the signal is too weak.")
    if "no network with ssid" in t or "ssid-not-found" in t:
        return "notfound", f"The board can't see a Wi-Fi network called \"{ssid}\"."
    if "ip-config-unavailable" in t or "dhcp" in t:
        return "noaddress", "The board joined the Wi-Fi but the router didn't give it an address."
    if "timeout" in t or "timed out" in t:
        return "other", "Connecting took too long (weak signal, or a wrong password)."
    return "other", ("Could not connect" + (f": {text.strip()}" if text and text.strip() else "."))


def save_wifi_error(ssid, kind, message):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(LAST_ERROR, "w") as f:
            json.dump({"ssid": ssid, "kind": kind, "message": message, "time": time.strftime("%Y-%m-%d %H:%M")}, f)
    except OSError:
        pass


def load_wifi_error():
    try:
        return json.load(open(LAST_ERROR))
    except (OSError, ValueError):
        return None


def clear_wifi_error():
    try:
        os.remove(LAST_ERROR)
    except OSError:
        pass


def nm_failure_reason():
    """Most recent 'failed (reason ...)' of the Wi-Fi device in NetworkManager's log this boot."""
    dev = wifi_device() or "wlan"
    r = run(["journalctl", "-u", "NetworkManager", "-b", "-o", "cat", "--no-pager", "-n", "600"], timeout=20)
    reason = ""
    for line in r.stdout.splitlines():
        if f"({dev})" in line or "ffbridge-wifi" in line:
            m = re.search(r"-> failed \(reason '([a-z0-9-]+)'", line)
            if m:
                reason = m.group(1)
    return reason


def saved_wifi():
    """(name, password length) of the saved Wi-Fi, or ('', 0) when none is saved."""
    r = run(["nmcli", "-s", "-g", "802-11-wireless.ssid,802-11-wireless-security.psk", "connection", "show", WIFI_CON])
    if r.returncode != 0:
        return "", 0
    lines = r.stdout.split("\n")
    return (lines[0] if lines else ""), (len(lines[1]) if len(lines) > 1 else 0)


def cached_networks():
    try:
        return json.load(open(SCAN_CACHE))
    except (OSError, ValueError):
        return []


def diagnose_wifi(ssid, psk_len, nets, last_error=None, nm_reason=""):
    """Returns (problem, what-to-do) for a saved Wi-Fi that isn't connected."""
    fix_file = "Fix it in ffbridge-config.txt on the SD card, or on the setup page (Wi-Fi tab)."
    if ssid != ssid.strip():
        return (f"The Wi-Fi name \"{ssid}\" has a space at the start or end.",
                "Remove the extra space after wifi_name= . " + fix_file)
    if 0 < psk_len < 8 or psk_len > 64:
        return (f"The password has {psk_len} characters. Wi-Fi passwords are 8 to 63 characters, so it's mistyped.",
                "Type the password again after wifi_password= . " + fix_file)
    names = [n.get("ssid", "") for n in nets]
    if names and ssid not in names:
        close = [n for n in names if n.strip().lower() == ssid.strip().lower()]
        if close:
            return (f"The board can't see \"{ssid}\", but it can see \"{close[0]}\".",
                    "Upper and lower case matter: type the name exactly as shown. " + fix_file)
        return (f"The board can't see a Wi-Fi network called \"{ssid}\".",
                "Check the spelling (upper/lower case matters) against the list below. If your network isn't "
                "in the list, the board may be too far from the router. " + fix_file)
    if last_error and last_error.get("ssid") == ssid and last_error.get("kind") not in (None, "", "other"):
        kind, msg = last_error["kind"], last_error["message"]
    elif nm_reason:
        kind, msg = explain_failure(nm_reason, ssid)
    elif last_error and last_error.get("ssid") == ssid:
        kind, msg = last_error.get("kind", "other"), last_error.get("message", "")
    else:
        kind, msg = "other", ""
    if kind == "password" or (not msg and names):
        return (msg or f"\"{ssid}\" is in range, but the board couldn't join it. That almost always means a wrong password.",
                f"The password you typed has {psk_len} characters - check it letter by letter "
                "(upper/lower case matters). " + fix_file)
    if kind == "noaddress":
        return msg, "Restart your router and the board. If it keeps happening, the router may block new devices."
    if kind == "notfound":
        return msg, "Check the spelling (upper/lower case matters). " + fix_file
    return (msg or "Not connected yet (the board is still trying).",
            "Wait a few minutes. If it stays like this, check the Wi-Fi name and password. " + fix_file)


def status_text(st, ssid, psk_len, cfg_ssid, problem, nets, clients=0):
    """The contents of WIFI-STATUS.txt (without the time line)."""
    host = st.get("hostname") or "ffbridge"
    eth, wifi, hs = st["ethernet"], st["wifi"], st["hotspot"]
    ips = [x for x in (eth.get("ip") if eth["connected"] else "", wifi.get("ip") if wifi["connected"] else "") if x]
    L = []
    if wifi["connected"]:
        L += [f"GOOD: Connected to the Wi-Fi \"{wifi.get('ssid') or ssid}\"."]
    elif eth["connected"]:
        L += ["GOOD: Connected with a network cable."]
    elif hs["active"]:
        L += ["NOT CONNECTED to your home network."]
    else:
        L += ["Starting up / looking for your network..."]
    if not wifi["connected"]:
        if ssid and problem:
            L += ["", f"Wi-Fi \"{ssid}\" did not connect.", f"  Problem:    {problem[0]}", f"  What to do: {problem[1]}"]
        elif cfg_ssid and not ssid:
            L += ["", f"Wi-Fi \"{cfg_ssid}\" from ffbridge-config.txt could not be saved.",
                  f"  Problem:    {problem[0] if problem else 'unknown'}"]
        elif not ssid and not eth["connected"]:
            L += ["", "No Wi-Fi is set up yet: wifi_name= in ffbridge-config.txt is empty.",
                  "  What to do: type your Wi-Fi name and password into ffbridge-config.txt on the SD card,",
                  "              or plug the board into your router with a network cable."]
    L += [""]
    if ips:
        L += ["Setup page:  http://" + host + ".local"] + [f"         or  http://{ip}" for ip in ips]
    if hs["active"]:
        L += ["Setup Wi-Fi hotspot: ON",
              f"  Connect a phone to the Wi-Fi \"{hs['ssid']}\" (password: {hs['password']}),",
              "  then open http://10.42.0.1 and choose your home Wi-Fi there.",
              f"  (Every {RETRY_EVERY // 60} minutes the board tries your saved Wi-Fi again, but not while"
              " a phone is connected to the hotspot.)"]
    L += ["", "Network cable: " + (f"connected ({eth['ip']})" if eth["connected"] else "not plugged in")]
    if not wifi["present"]:
        L += ["Wi-Fi: no Wi-Fi hardware found"]
    if nets and not wifi["connected"]:
        L += ["", "Wi-Fi networks the board can see (strongest first):"]
        for n in nets[:15]:
            bar = "strong" if n.get("signal", 0) >= 60 else "ok" if n.get("signal", 0) >= 35 else "weak"
            L += [f"  \"{n.get('ssid', '')}\"  ({bar})"]
    return "\n".join(L)


def write_status_file(text, _last=[None]):
    """Writes WIFI-STATUS.txt on the SD card's FFBRIDGE drive (only when something changed)."""
    if text == _last[0] or not os.path.isdir(SETUP_DIR):
        return
    body = ("FlashForge Bridge - network status\n==================================\n"
            f"Written: {time.strftime('%Y-%m-%d %H:%M')} (board clock - may be wrong until it's online)\n\n"
            + text + "\n\n(The board rewrites this file whenever its network status changes.)\n")
    try:
        with open(STATUS_FILE, "w", newline="\r\n") as f:  # \r\n: Notepad-friendly
            f.write(body)
            f.flush()
            os.fsync(f.fileno())
        _last[0] = text
    except OSError as e:
        log(f"could not write {STATUS_FILE}: {e}")


def hotspot_clients(dev):
    """Number of phones/computers connected to the setup hotspot."""
    if not dev:
        return 0
    r = run(["iw", "dev", dev, "station", "dump"])
    if r.returncode == 0:
        return sum(1 for line in r.stdout.splitlines() if line.startswith("Station "))
    r = run(["ip", "neigh", "show", "dev", dev])
    return sum(1 for line in r.stdout.splitlines() if line.startswith("10.42.") and re.search(r"REACHABLE|DELAY|PROBE", line))


def update_status(clients=0):
    st = net_status()
    ssid, psk_len = saved_wifi()
    cfg_ssid = parse_config().get("wifi_name") or ""
    problem = None
    if not st["wifi"]["connected"]:
        err = load_wifi_error()
        if ssid:
            problem = diagnose_wifi(ssid, psk_len, cached_networks(), err, nm_failure_reason())
        elif cfg_ssid and err:
            problem = (err.get("message", ""), "Fix it in ffbridge-config.txt on the SD card.")
    else:
        clear_wifi_error()
    write_status_file(status_text(st, ssid, psk_len, cfg_ssid, problem, cached_networks(), clients))
    return problem


def wifi_scan():
    if hotspot_active():
        try:
            nets = json.load(open(SCAN_CACHE))
            return {"ok": True, "networks": nets, "message": "List from before the setup hotspot started."}
        except (OSError, ValueError):
            return {"ok": True, "networks": [], "message": "Can't search while the setup hotspot is on. Type your Wi-Fi name below."}
    dev = wifi_device()
    if not dev:
        return {"ok": False, "networks": [], "message": "No Wi-Fi hardware found on this board."}
    run(["nmcli", "device", "wifi", "rescan", "ifname", dev], timeout=20)
    time.sleep(3)
    r = run(["nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "ifname", dev], timeout=30)
    best = {}
    for line in r.stdout.splitlines():
        f = nm_fields(line)
        if len(f) < 4 or not f[1]:
            continue
        sig = int(f[2] or 0)
        cur = best.get(f[1])
        if not cur or sig > cur["signal"]:
            best[f[1]] = {"ssid": f[1], "signal": sig, "security": f[3] not in ("", "--"), "inUse": f[0] == "*"}
    nets = sorted(best.values(), key=lambda n: -n["signal"])
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        json.dump(nets, open(SCAN_CACHE, "w"))
    except OSError:
        pass
    return {"ok": True, "networks": nets}


def net_status():
    st = {"ok": True, "hostname": open("/etc/hostname").read().strip() if os.path.exists("/etc/hostname") else "",
          "ethernet": {"connected": False, "ip": ""},
          "wifi": {"present": False, "connected": False, "ssid": "", "ip": "", "signal": 0},
          "hotspot": {"active": False, "ssid": hotspot_ssid(), "password": HOTSPOT_PASSWORD}}
    r = run(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device"])
    for line in r.stdout.splitlines():
        f = nm_fields(line)
        if len(f) < 4:
            continue
        if f[1] == "ethernet" and f[2].startswith("connected"):
            st["ethernet"] = {"connected": True, "ip": ipv4_of(f[0])}
        if f[1] == "wifi":
            st["wifi"]["present"] = True
            if f[2].startswith("connected"):
                if f[3] == HOTSPOT_CON:
                    st["hotspot"]["active"] = True
                else:
                    st["wifi"].update({"connected": True, "ip": ipv4_of(f[0])})
                    w = run(["nmcli", "-t", "-f", "ACTIVE,SSID,SIGNAL", "device", "wifi", "list", "ifname", f[0], "--rescan", "no"])
                    for wl in w.stdout.splitlines():
                        wf = nm_fields(wl)
                        if len(wf) >= 3 and wf[0] == "yes":
                            st["wifi"].update({"ssid": wf[1], "signal": int(wf[2] or 0)})
    return st


def start_hotspot():
    dev = wifi_device()
    if not dev:
        return False
    try:  # remember nearby networks for the setup page (can't scan while the hotspot is up)
        wifi_scan()
    except Exception:  # noqa: BLE001
        pass
    run(["nmcli", "connection", "delete", HOTSPOT_CON])
    r = run(["nmcli", "connection", "add", "type", "wifi", "ifname", dev, "con-name", HOTSPOT_CON,
             "autoconnect", "no", "ssid", hotspot_ssid(), "802-11-wireless.mode", "ap", "802-11-wireless.band", "bg",
             "ipv4.method", "shared", "ipv4.addresses", "10.42.0.1/24", "ipv6.method", "disabled",
             "wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", HOTSPOT_PASSWORD])
    if r.returncode != 0:
        log("hotspot setup failed: " + r.stderr.strip())
        return False
    r = run(["nmcli", "--wait", "20", "connection", "up", HOTSPOT_CON], timeout=40)
    log("setup hotspot " + ("started: " + hotspot_ssid() if r.returncode == 0 else "failed: " + r.stderr.strip()))
    return r.returncode == 0


def hotspot_watch():
    """Starts the setup hotspot when the board has no network ~90 s after boot. While it runs, the
    saved Wi-Fi is retried every 5 minutes (e.g. the router was off when the board started), but
    never while a phone is connected to the hotspot: retrying switches the hotspot off for up to a
    minute, which would cut off someone who is using the setup page. Also keeps WIFI-STATUS.txt on
    the SD card up to date, so a beginner can see why the Wi-Fi didn't connect."""
    if printernet_state()["enabled"]:
        printernet_loop()   # returns when printer network mode is switched off
    write_status_file("Starting up / looking for your network...")
    for _ in range(90):
        if has_network():
            break
        time.sleep(1)
    last_retry = time.time()
    last_scan = 0.0
    deferred = False
    while True:
        clients = 0
        try:
            now = time.time()
            if printernet_state()["enabled"]:
                printernet_loop()
                continue
            if has_network():
                if hotspot_active():
                    run(["nmcli", "connection", "down", HOTSPOT_CON])
                # Online by cable but the saved Wi-Fi is failing: refresh the network list now and then
                # so the status file can tell "name not found" from "wrong password".
                ssid, _ = saved_wifi()
                if ssid and not net_status()["wifi"]["connected"] and now - last_scan > 600:
                    last_scan = now
                    wifi_scan()
            elif not hotspot_active():
                start_hotspot()  # scans first, so the network list is fresh
                last_retry = now
            else:
                clients = hotspot_clients(wifi_device())
                if now - last_retry > RETRY_EVERY and saved_wifi()[0]:
                    if clients and now - last_retry < MAX_DEFER:
                        if not deferred:
                            log(f"not retrying the saved Wi-Fi: {clients} device(s) connected to the setup hotspot")
                            deferred = True
                    else:
                        deferred = False
                        last_retry = now
                        log("retrying saved Wi-Fi")
                        run(["nmcli", "connection", "down", HOTSPOT_CON])
                        time.sleep(2)
                        r = run(["nmcli", "--wait", "30", "connection", "up", WIFI_CON], timeout=45)
                        if r.returncode == 0:
                            clear_wifi_error()
                        else:
                            ssid = saved_wifi()[0]
                            kind, msg = explain_failure((r.stderr or r.stdout) + " " + nm_failure_reason(), ssid)
                            save_wifi_error(ssid, kind, msg)
                            start_hotspot()
            update_status(clients)
        except Exception as e:  # noqa: BLE001
            log(f"hotspot-watch: {e}")
        time.sleep(15)


# ----------------------------------------------------------------------------- printer network
# "Printer network" (router mode, advanced, off by default): the board's Wi-Fi becomes a private
# network just for the printers, and the board itself joins the home network by Ethernet.
# The printers get no way out: IP forwarding is off and a firewall drops anything they send
# through the board. Everything people use still works, because it all goes through the bridge
# (printer screen, Mainsail, OrcaSlicer, camera, AI, Discord). Internet for the printers (firmware
# updates) can be allowed for a limited time; it switches itself off again.
# The board also serves the time (chrony) so the printers' clocks stay right without internet.
PRINTERNET_FILE = os.path.join(STATE_DIR, "printer-network.json")
PRINTERNET_CON = "ffbridge-printers"
PRINTERNET_NET = "10.43.0"            # board = .1, printers get .50-.150 (setup hotspot uses 10.42.0.x)
PRINTERNET_LEASES = "/run/ffbridge-printers.leases"   # readable by the bridge (shows connected printers)
NFT_TABLE = "ffbridge_printers"


def printernet_state():
    try:
        st = json.load(open(PRINTERNET_FILE))
    except (OSError, ValueError):
        st = {}
    st.setdefault("enabled", False)
    st.setdefault("ssid", "FFBridge-Printers")
    st.setdefault("password", "")
    st.setdefault("internetUntil", 0)       # epoch seconds; -1 = until turned off; 0 = off
    return st


def printernet_save(st):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = PRINTERNET_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
    os.chmod(tmp, 0o600)   # holds the Wi-Fi password
    os.replace(tmp, PRINTERNET_FILE)


def internet_allowed(st, now=None):
    u = st.get("internetUntil", 0)
    return u == -1 or (u > 0 and u > (now or time.time()))


def ethernet_ip():
    r = run(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device"])
    for line in r.stdout.splitlines():
        f = nm_fields(line)
        if len(f) >= 3 and f[1] == "ethernet" and f[2].startswith("connected"):
            ip = ipv4_of(f[0])
            if ip and not ip.startswith("169.254."):
                return ip
    return ""


def printernet_leases():
    """Devices that got an address on the printer network (dnsmasq lease file)."""
    out_ = []
    try:
        for line in open(PRINTERNET_LEASES):
            p = line.split()
            if len(p) >= 4:
                out_.append({"ip": p[2], "mac": p[1], "name": "" if p[3] == "*" else p[3], "expires": int(p[0])})
    except OSError:
        pass
    return out_


def nft_rules(dev, allow):
    """The firewall for the printer network. Printers may only talk to the board itself, unless
    internet is allowed (then their traffic is passed on and NATed)."""
    net = PRINTERNET_NET + ".0/24"
    fwd = "accept" if allow else "drop"
    nat = f'    ip saddr {net} oifname != "{dev}" masquerade\n' if allow else ""
    return (f"table ip {NFT_TABLE}\ndelete table ip {NFT_TABLE}\n"
            f"table ip {NFT_TABLE} {{\n"
            f"  chain forward {{\n    type filter hook forward priority -10; policy accept;\n"
            f'    iifname "{dev}" {fwd}\n'
            f'    oifname "{dev}" ct state established,related accept\n'
            f'    oifname "{dev}" drop\n  }}\n'
            f"  chain postrouting {{\n    type nat hook postrouting priority 110; policy accept;\n{nat}  }}\n}}\n")


def printernet_firewall(dev, allow):
    """Returns '' or a problem message. With internet off the printers stay isolated even without
    the firewall tool, because forwarding is switched off."""
    try:
        with open("/proc/sys/net/ipv4/ip_forward", "w") as f:
            f.write("1\n" if allow else "0\n")
    except OSError as e:
        return f"could not set IP forwarding: {e}"
    if not os.path.exists("/usr/sbin/nft"):
        return "the firewall tool (nft) is missing, so internet can't be passed on to the printers" if allow else ""
    r = run(["nft", "-f", "-"], input_text=nft_rules(dev, allow))
    return "" if r.returncode == 0 else "firewall: " + (r.stderr or r.stdout).strip()


def printernet_firewall_off():
    if os.path.exists("/usr/sbin/nft"):
        run(["nft", "delete", "table", "ip", NFT_TABLE])


def printernet_ap_up(st, dev):
    run(["nmcli", "radio", "wifi", "on"])
    run(["nmcli", "connection", "modify", WIFI_CON, "connection.autoconnect", "no"])  # keep, but don't use
    run(["nmcli", "connection", "down", WIFI_CON])
    run(["nmcli", "connection", "down", HOTSPOT_CON])
    run(["nmcli", "connection", "delete", PRINTERNET_CON])
    r = run(["nmcli", "connection", "add", "type", "wifi", "ifname", dev, "con-name", PRINTERNET_CON,
             "autoconnect", "yes", "ssid", st["ssid"], "802-11-wireless.mode", "ap", "802-11-wireless.band", "bg",
             "802-11-wireless.powersave", "2",
             "ipv4.method", "manual", "ipv4.addresses", PRINTERNET_NET + ".1/24", "ipv4.never-default", "yes",
             "ipv6.method", "disabled", "wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", st["password"]])
    if r.returncode != 0:
        return "could not create the printer Wi-Fi: " + r.stderr.strip()
    r = run(["nmcli", "--wait", "20", "connection", "up", PRINTERNET_CON], timeout=40)
    return "" if r.returncode == 0 else "could not start the printer Wi-Fi: " + (r.stderr or r.stdout).strip()


def printernet_dnsmasq(dev):
    """DHCP (+ DNS + time server address) for the printers only."""
    return subprocess.Popen(
        ["dnsmasq", "--keep-in-foreground", "--conf-file=/dev/null", f"--interface={dev}", "--bind-interfaces",
         "--except-interface=lo", f"--listen-address={PRINTERNET_NET}.1",
         f"--dhcp-range={PRINTERNET_NET}.50,{PRINTERNET_NET}.150,12h", f"--dhcp-leasefile={PRINTERNET_LEASES}",
         f"--dhcp-option=option:router,{PRINTERNET_NET}.1", f"--dhcp-option=option:dns-server,{PRINTERNET_NET}.1",
         f"--dhcp-option=option:ntp-server,{PRINTERNET_NET}.1", "--dhcp-authoritative", "--no-hosts",
         f"--pid-file=/run/ffbridge-printers-dnsmasq.pid"],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)


def printernet_loop():
    """Runs inside hotspot-watch while the printer network is switched on. Returns when it is
    switched off (the normal Wi-Fi / setup hotspot logic then takes over again)."""
    dev = wifi_device()
    if not dev:
        log("printer network: no Wi-Fi hardware")
        time.sleep(60)
        return
    run(["systemctl", "try-restart", "chrony"])  # picks up conf.d/ffbridge-printers.conf (time for the printers)
    dns = None
    last_allow = None
    problem_logged = ""
    try:
        while True:
            st = printernet_state()
            if not st["enabled"]:
                return
            try:
                active = PRINTERNET_CON in run(["nmcli", "-t", "-f", "NAME", "connection", "show", "--active"]).stdout.splitlines()
                if not active:
                    err = printernet_ap_up(st, dev)
                    if err and err != problem_logged:
                        log("printer network: " + err)
                        problem_logged = err
                    time.sleep(2)
                if dns is None or dns.poll() is not None:
                    if dns is not None:
                        log("printer network: DHCP server stopped (" + (dns.stderr.read() or "").strip()[-200:] + "), restarting")
                    dns = printernet_dnsmasq(dev)
                allow = internet_allowed(st)
                if allow != last_allow:
                    err = printernet_firewall(dev, allow)
                    log("printer network: internet for printers " + ("ALLOWED" if allow else "blocked") + (f" ({err})" if err else ""))
                    last_allow = allow
                if st["internetUntil"] > 0 and not allow:  # timer ran out: tidy up the state file
                    st["internetUntil"] = 0
                    printernet_save(st)
                write_status_file(f"Printer network mode is ON.\r\n\r\nPrinter Wi-Fi: {st['ssid']}\r\n"
                                  f"This board on your home network (Ethernet): {ethernet_ip() or 'NOT CONNECTED - plug in the network cable'}\r\n"
                                  f"Internet for the printers: {'allowed' if allow else 'blocked'}\r\n")
            except Exception as e:  # noqa: BLE001
                log(f"printer network: {e}")
            time.sleep(10)
    finally:
        if dns is not None and dns.poll() is None:
            dns.terminate()
            try:
                dns.wait(5)
            except subprocess.TimeoutExpired:
                dns.kill()


def printernet_status():
    st = printernet_state()
    dev = wifi_device()
    active = PRINTERNET_CON in run(["nmcli", "-t", "-f", "NAME", "connection", "show", "--active"]).stdout.splitlines()
    now = time.time()
    return {"ok": True, "enabled": st["enabled"], "active": active, "ssid": st["ssid"], "hasPassword": bool(st["password"]),
            "address": PRINTERNET_NET + ".1", "wifiPresent": bool(dev), "ethernetIp": ethernet_ip(),
            "internet": {"allowed": internet_allowed(st, now), "until": st["internetUntil"],
                         "minutesLeft": max(0, int((st["internetUntil"] - now) // 60)) if st["internetUntil"] > 0 else None},
            "firewall": os.path.exists("/usr/sbin/nft"), "clients": printernet_leases()}


def printernet_enable(ssid, password):
    ssid = (ssid or "").strip()
    if not (1 <= len(ssid.encode()) <= 32):
        return {"ok": False, "message": "The printer Wi-Fi name must be 1 to 32 characters."}
    st = printernet_state()
    if password:
        if not 8 <= len(password) <= 63:
            return {"ok": False, "message": "The printer Wi-Fi password must be 8 to 63 characters."}
        st["password"] = password
    if not st["password"]:
        return {"ok": False, "message": "Choose a password for the printer Wi-Fi (8 to 63 characters)."}
    if not wifi_device():
        return {"ok": False, "message": "No Wi-Fi hardware found on this board."}
    if not ethernet_ip():
        return {"ok": False, "message": "Connect the board to your router with a network cable first. In printer network "
                                         "mode the board's Wi-Fi is used by the printers, so the cable is how the board stays on your home network."}
    st.update({"enabled": True, "ssid": ssid, "internetUntil": 0})
    printernet_save(st)
    run(["systemctl", "restart", "ffbridge-hotspot"])   # the watcher switches into printer network mode
    return {"ok": True, "message": f"Printer network \"{ssid}\" is starting. Now connect each printer to it on the printer's screen."}


def printernet_disable():
    st = printernet_state()
    st.update({"enabled": False, "internetUntil": 0})
    printernet_save(st)
    run(["systemctl", "stop", "ffbridge-hotspot"])
    run(["nmcli", "connection", "down", PRINTERNET_CON])
    run(["nmcli", "connection", "delete", PRINTERNET_CON])
    printernet_firewall_off()
    try:
        with open("/proc/sys/net/ipv4/ip_forward", "w") as f:
            f.write("0\n")
    except OSError:
        pass
    if saved_wifi()[0]:
        run(["nmcli", "connection", "modify", WIFI_CON, "connection.autoconnect", "yes"])
        run(["nmcli", "--wait", "30", "connection", "up", WIFI_CON], timeout=45)
    run(["systemctl", "start", "ffbridge-hotspot"])
    return {"ok": True, "message": "Printer network switched off. Connect the printers to your home Wi-Fi again on their screens."}


def printernet_internet(minutes):
    st = printernet_state()
    if not st["enabled"]:
        return {"ok": False, "message": "The printer network is off."}
    m = int(minutes)
    st["internetUntil"] = 0 if m == 0 else (-1 if m < 0 else int(time.time()) + m * 60)
    printernet_save(st)
    # apply right away instead of waiting for the watcher's next round
    dev = wifi_device()
    err = printernet_firewall(dev, internet_allowed(st)) if dev else ""
    if m == 0:
        msg = "Internet for the printers is blocked."
    elif m < 0:
        msg = "Internet for the printers is allowed until you turn it off."
    else:
        msg = f"Internet for the printers is allowed for {m} minutes, then it switches off by itself."
    return {"ok": not err, "message": msg + (f" Problem: {err}" if err else "")}


# ----------------------------------------------------------------------------- updates
# One-click updates: GitHub's build publishes ffbridge-update.json + ffbridge-update.tar.gz next
# to the SD card image. The package holds the bridge program, the web page, the AI service code
# and the board's system scripts (everything except system packages and the AI model).
# The previous version is kept; if the new bridge doesn't answer within 90 s it is rolled back.
UPDATE_ROOT = os.environ.get("FFB_ROOT", "/")            # tests install into a fake root
UPDATE_DIR = os.path.join(STATE_DIR, "update")
UPDATE_STATUS = os.path.join(UPDATE_DIR, "status.json")
UPDATE_TEST = os.environ.get("FFB_UPDATE_TEST") == "1"     # no systemctl / no real health check


def set_update_state(state, message, **extra):
    os.makedirs(UPDATE_DIR, exist_ok=True)
    d = {"state": state, "message": message, "time": time.strftime("%Y-%m-%d %H:%M:%S"), **extra}
    tmp = UPDATE_STATUS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f)
    os.replace(tmp, UPDATE_STATUS)
    log(f"update: {state}: {message}")
    return d


def _download(url, dest, timeout=120):
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "ffbridge-updater"})
    with urllib.request.urlopen(req, timeout=timeout) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(65536)
            if not chunk:
                break
            f.write(chunk)


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _healthy(version, wait=90):
    """True when the restarted bridge answers on the page (with the new version, if readable)."""
    if UPDATE_TEST:
        return os.environ.get("FFB_UPDATE_TEST_HEALTHY", "1") == "1"
    import urllib.error
    import urllib.request
    deadline = time.time() + wait
    while time.time() < deadline:
        time.sleep(3)
        try:
            with urllib.request.urlopen("http://127.0.0.1/api/status", timeout=5) as r:
                v = json.loads(r.read().decode()).get("version", "")
                if v == version:
                    return True
        except urllib.error.HTTPError as e:
            if e.code == 401:  # page password set: it's running, can't read the version
                return True
        except Exception:  # noqa: BLE001
            pass
    return False


def _systemctl(*args):
    if not UPDATE_TEST:
        run(["systemctl", *args], timeout=120)


def update_run(base_url):
    """Downloads, verifies and installs the update from base_url (…/releases/download/latest-image)."""
    import shutil
    import tarfile
    work = os.path.join(UPDATE_DIR, "work")
    prev = os.path.join(UPDATE_DIR, "previous")
    try:
        shutil.rmtree(work, ignore_errors=True)
        os.makedirs(work)
        set_update_state("downloading", "Downloading the update…")
        man_path = os.path.join(work, "manifest.json")
        _download(base_url.rstrip("/") + "/ffbridge-update.json", man_path, timeout=30)
        man = json.load(open(man_path))
        version = man["version"]
        pkg = os.path.join(work, "ffbridge-update.tar.gz")
        _download(base_url.rstrip("/") + "/ffbridge-update.tar.gz", pkg)
        if _sha256(pkg) != man["sha256"]:
            return set_update_state("failed", "The download was damaged (checksum mismatch). Nothing was changed — try again.")
        cur_hash = ""
        try:
            cur_hash = open(os.path.join(UPDATE_ROOT, "opt/ffbridge/IMAGE_HASH")).read().strip()
        except OSError:
            pass
        if man.get("imageHash") and cur_hash and man["imageHash"] != cur_hash:
            return set_update_state("image-required", "This update changes system packages, so it needs a new SD card image. Nothing was changed.")

        set_update_state("installing", f"Installing version {version}…", version=version)
        new = os.path.join(work, "new")
        with tarfile.open(pkg) as t:
            for m in t.getmembers():  # refuse anything that would escape the folder
                if m.name.startswith("/") or ".." in m.name.split("/") or not (m.isfile() or m.isdir()):
                    return set_update_state("failed", f"The update package contains an unexpected entry ({m.name}). Nothing was changed.")
            t.extractall(new)

        replace_dirs = man.get("replaceDirs", [])
        files = []
        for dirpath, _, names in os.walk(new):
            for n in names:
                rel = os.path.relpath(os.path.join(dirpath, n), new).replace(os.sep, "/")
                if not any(rel == d or rel.startswith(d + "/") for d in replace_dirs):
                    files.append(rel)

        # keep the current version for rollback
        shutil.rmtree(prev, ignore_errors=True)
        os.makedirs(prev)
        created = []
        for d in replace_dirs:
            src = os.path.join(UPDATE_ROOT, d)
            if os.path.isdir(src):
                shutil.copytree(src, os.path.join(prev, d), symlinks=True)
        for rel in files:
            dst = os.path.join(UPDATE_ROOT, rel)
            if os.path.exists(dst):
                os.makedirs(os.path.dirname(os.path.join(prev, rel)), exist_ok=True)
                shutil.copy2(dst, os.path.join(prev, rel))
            else:
                created.append(rel)
        json.dump({"created": created, "replaceDirs": replace_dirs, "files": files}, open(os.path.join(prev, ".rollback.json"), "w"))

        def install(source_root):
            for d in replace_dirs:
                dst = os.path.join(UPDATE_ROOT, d)
                if os.path.isdir(os.path.join(source_root, d)):
                    tmp = dst + ".new"
                    shutil.rmtree(tmp, ignore_errors=True)
                    shutil.copytree(os.path.join(source_root, d), tmp, symlinks=True)
                    shutil.rmtree(dst, ignore_errors=True)
                    os.rename(tmp, dst)
            for rel in files:
                src = os.path.join(source_root, rel)
                if not os.path.exists(src):
                    continue
                dst = os.path.join(UPDATE_ROOT, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                tmp = dst + ".ffbnew"
                shutil.copy2(src, tmp)
                os.replace(tmp, dst)  # atomic per file: a running program keeps its old copy

        install(new)
        if any(f.startswith("etc/sudoers.d/") for f in files):
            for f in files:
                if f.startswith("etc/sudoers.d/"):
                    os.chmod(os.path.join(UPDATE_ROOT, f), 0o440)
        _systemctl("daemon-reload")
        for rel in created:  # a service that is new in this version: switch it on
            if rel.startswith("etc/systemd/system/") and rel.endswith(".service"):
                _systemctl("enable", "--now", os.path.basename(rel))
        if any(f.startswith("opt/ffbridge/ai/") for f in files):
            _systemctl("restart", "ffai")
        _systemctl("restart", "ffbridge")
        if _healthy(version):
            shutil.rmtree(work, ignore_errors=True)
            return set_update_state("done", f"Updated to version {version}.", version=version)

        # roll back
        set_update_state("rolling-back", "The new version didn't start. Going back to the previous version…")
        install(prev)
        for rel in created:
            try:
                os.remove(os.path.join(UPDATE_ROOT, rel))
            except OSError:
                pass
        _systemctl("daemon-reload")
        _systemctl("restart", "ffai")
        _systemctl("restart", "ffbridge")
        return set_update_state("rolled-back", f"Version {version} didn't start, so the previous version was restored. Nothing was lost.")
    except Exception as e:  # noqa: BLE001
        return set_update_state("failed", f"The update failed: {e}. Nothing was changed." if not os.path.exists(os.path.join(prev, ".rollback.json"))
                             else f"The update failed: {e}.")


def update_start(base_url):
    """Starts update_run in the background (outside the bridge's service, which gets restarted)."""
    if not re.fullmatch(r"https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/releases/download/[A-Za-z0-9._-]+", base_url):
        return {"ok": False, "message": "Invalid update address."}
    set_update_state("starting", "Starting the update…")
    helper = "/usr/local/sbin/ffbridge-helper"
    r = run(["systemd-run", "--unit", f"ffbridge-update-{int(time.time())}", "--collect", helper, "update-run", base_url])
    if r.returncode != 0:  # no systemd-run: detach ourselves
        subprocess.Popen([helper, "update-run", base_url], start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"ok": True, "message": "Update started."}


# ----------------------------------------------------------------------------- system
def set_hostname(name):
    name = re.sub(r"[^a-z0-9-]", "", name.lower())[:32]
    if not name:
        return {"ok": False, "message": "Invalid name"}
    run(["hostnamectl", "set-hostname", name])
    try:
        with open("/etc/hostname", "w") as f:
            f.write(name + "\n")
        hosts = open("/etc/hosts").read()
        hosts = re.sub(r"^127\.0\.1\.1\s+.*$", f"127.0.1.1\t{name}", hosts, flags=re.M)
        if "127.0.1.1" not in hosts:
            hosts += f"127.0.1.1\t{name}\n"
        open("/etc/hosts", "w").write(hosts)
    except OSError:
        pass
    run(["systemctl", "restart", "avahi-daemon"])
    return {"ok": True, "message": f"Renamed to {name}.local"}


def system_info():
    info = {"ok": True}
    try:
        info["model"] = open("/proc/device-tree/model").read().strip("\x00\n ")
    except OSError:
        pass
    try:
        for line in open("/etc/os-release"):
            if line.startswith("PRETTY_NAME="):
                info["os"] = line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    try:
        up = float(open("/proc/uptime").read().split()[0])
        d, h, m = int(up // 86400), int(up % 86400 // 3600), int(up % 3600 // 60)
        info["uptime"] = (f"{d} days " if d else "") + f"{h}h {m}m"
    except OSError:
        pass
    temps = []
    for z in sorted(os.listdir("/sys/class/thermal")) if os.path.isdir("/sys/class/thermal") else []:
        try:
            temps.append(int(open(f"/sys/class/thermal/{z}/temp").read()) / 1000)
        except (OSError, ValueError):
            pass
    if temps:
        info["temp"] = f"{max(temps):.0f} °C"
    try:
        mem = {l.split(":")[0]: int(l.split()[1]) for l in open("/proc/meminfo")}
        info["memory"] = f"{(mem['MemTotal'] - mem['MemAvailable']) / 1024:.0f} MB used of {mem['MemTotal'] / 1024:.0f} MB"
    except (OSError, KeyError, ValueError):
        pass
    try:
        s = os.statvfs("/")
        free, total = s.f_bavail * s.f_frsize / 1e9, s.f_blocks * s.f_frsize / 1e9
        info["disk"] = f"{free:.1f} GB free of {total:.1f} GB"
    except OSError:
        pass
    return info


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "firstboot":
        firstboot()
    elif cmd == "apply-config":
        apply_config()
    elif cmd == "hotspot-watch":
        hotspot_watch()
    elif cmd == "net-status":
        st = net_status()
        if not st["wifi"]["connected"]:
            ssid, psk_len = saved_wifi()
            err, reason = load_wifi_error(), nm_failure_reason()
            if ssid and (err or reason):  # only once an attempt has actually failed
                p = diagnose_wifi(ssid, psk_len, cached_networks(), err, reason)
                st["wifi"].update({"savedSsid": ssid, "problem": p[0], "fix": p[1]})
        out(st)
    elif cmd == "wifi-scan":
        out(wifi_scan())
    elif cmd == "wifi-connect" and args:
        out(wifi_configure(args[0], sys.stdin.read().rstrip("\r\n")))
    elif cmd == "wifi-forget":
        run(["nmcli", "connection", "delete", WIFI_CON])
        out({"ok": True, "message": "Saved Wi-Fi removed."})
    elif cmd == "set-hostname" and args:
        out(set_hostname(args[0]))
    elif cmd == "update-start" and args:
        out(update_start(args[0]))
    elif cmd == "update-run" and args:
        update_run(args[0])
    elif cmd == "printernet-status":
        out(printernet_status())
    elif cmd == "printernet-enable" and args:
        out(printernet_enable(args[0], sys.stdin.read().rstrip("\r\n")))
    elif cmd == "printernet-disable":
        out(printernet_disable())
    elif cmd == "printernet-internet" and args:
        out(printernet_internet(args[0]))
    elif cmd == "restart-ai":
        r = run(["systemctl", "restart", "ffai"])
        out({"ok": r.returncode == 0, "message": "AI service restarted." if r.returncode == 0 else r.stderr.strip()})
    elif cmd == "ai-pause":
        out(ai_pause())
    elif cmd == "ai-resume":
        out(ai_resume())
    elif cmd == "zram-setup":
        out(zram_setup())
    elif cmd == "system-info":
        out(system_info())
    elif cmd == "reboot":
        out({"ok": True})
        sys.stdout.flush()
        run(["systemctl", "reboot"])
    elif cmd == "shutdown":
        out({"ok": True})
        sys.stdout.flush()
        run(["systemctl", "poweroff"])
    else:
        out({"ok": False, "message": f"unknown command {cmd}"})
        sys.exit(2)


if __name__ == "__main__":
    main()
