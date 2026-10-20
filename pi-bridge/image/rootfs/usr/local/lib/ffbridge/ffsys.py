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
ADMIN_USER = "ffadmin"


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
        return {"ok": False, "message": "No Wi-Fi hardware found on this board."}
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
        return {"ok": False, "message": "Could not save the Wi-Fi settings: " + (r.stderr or r.stdout).strip()}
    if not connect:
        return {"ok": True, "message": f"Wi-Fi \"{ssid}\" saved."}
    was_hotspot = hotspot_active()
    if was_hotspot:
        run(["nmcli", "connection", "down", HOTSPOT_CON])
        time.sleep(2)
    r = run(["nmcli", "--wait", str(timeout), "connection", "up", WIFI_CON], timeout=timeout + 15)
    if r.returncode == 0:
        time.sleep(2)
        return {"ok": True, "message": f"Connected to \"{ssid}\" ({ipv4_of(dev) or 'getting an address'}).", "ip": ipv4_of(dev)}
    msg = (r.stderr or r.stdout).strip()
    if "Secrets were required" in msg or "802-1x" in msg or "psk" in msg.lower():
        msg = "Wrong Wi-Fi password."
    elif "No network with SSID" in msg:
        msg = f"Network \"{ssid}\" not found. Check the name (upper/lower case matters) and that the router is in range."
    if was_hotspot:
        start_hotspot()
    return {"ok": False, "message": "Could not connect: " + msg}


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
    """Starts the setup hotspot when the board has no network ~90 s after boot; while it runs,
    retries the saved Wi-Fi every 5 minutes (e.g. the router was off when the board started)."""
    for _ in range(90):
        if has_network():
            break
        time.sleep(1)
    last_retry = time.time()
    while True:
        try:
            if has_network():
                if hotspot_active():
                    run(["nmcli", "connection", "down", HOTSPOT_CON])
            elif not hotspot_active():
                start_hotspot()
                last_retry = time.time()
            elif time.time() - last_retry > 300:
                last_retry = time.time()
                if run(["nmcli", "-t", "-f", "NAME", "connection", "show"]).stdout.count(WIFI_CON):
                    log("retrying saved Wi-Fi")
                    run(["nmcli", "connection", "down", HOTSPOT_CON])
                    time.sleep(2)
                    if run(["nmcli", "--wait", "30", "connection", "up", WIFI_CON], timeout=45).returncode != 0:
                        start_hotspot()
        except Exception as e:  # noqa: BLE001
            log(f"hotspot-watch: {e}")
        time.sleep(15)


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
        out(net_status())
    elif cmd == "wifi-scan":
        out(wifi_scan())
    elif cmd == "wifi-connect" and args:
        out(wifi_configure(args[0], sys.stdin.read().rstrip("\r\n")))
    elif cmd == "wifi-forget":
        run(["nmcli", "connection", "delete", WIFI_CON])
        out({"ok": True, "message": "Saved Wi-Fi removed."})
    elif cmd == "set-hostname" and args:
        out(set_hostname(args[0]))
    elif cmd == "restart-ai":
        r = run(["systemctl", "restart", "ffai"])
        out({"ok": r.returncode == 0, "message": "AI service restarted." if r.returncode == 0 else r.stderr.strip()})
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
