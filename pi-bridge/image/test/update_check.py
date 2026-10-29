#!/usr/bin/env python3
"""Tests the one-click update installer in ffsys.py against a fake board folder:
install, rollback when the new version doesn't start, damaged download, new image needed,
and a package that tries to write outside its folder.     python3 image/test/update_check.py"""
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.dirname(HERE)
fails = 0


def check(name, cond, detail=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"  -> {detail}"))
    fails += 0 if cond else 1


def load(root, state):
    os.environ["FFB_ROOT"] = root
    os.environ["FFB_UPDATE_TEST"] = "1"
    spec = importlib.util.spec_from_file_location("ffsys", os.path.join(IMG, "rootfs/usr/local/lib/ffbridge/ffsys.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    m.UPDATE_DIR = os.path.join(state, "update")
    m.UPDATE_STATUS = os.path.join(m.UPDATE_DIR, "status.json")
    return m


def fake_board(root):
    """The 'currently installed' version."""
    os.makedirs(f"{root}/opt/ffbridge/bin")
    os.makedirs(f"{root}/opt/ffbridge/setup-web/help")
    os.makedirs(f"{root}/usr/local/lib/ffbridge")
    open(f"{root}/opt/ffbridge/bin/pibridge", "w").write("OLD BINARY")
    open(f"{root}/opt/ffbridge/setup-web/index.html", "w").write("old page")
    open(f"{root}/opt/ffbridge/setup-web/obsolete.js", "w").write("removed in the new version")
    open(f"{root}/usr/local/lib/ffbridge/ffsys.py", "w").write("old helper")
    open(f"{root}/opt/ffbridge/IMAGE_HASH", "w").write(subprocess.check_output(["bash", f"{IMG}/image-hash.sh"]).decode().strip())


tmp = tempfile.mkdtemp()
pkgdir = os.path.join(tmp, "release")
binf = os.path.join(tmp, "pibridge")
open(binf, "w").write("NEW BINARY")
r = subprocess.run(["bash", f"{IMG}/make-update.sh", "--bridge-bin", binf, "--version", "1.0.99", "--out", pkgdir], capture_output=True, text=True)
check("update package builds", r.returncode == 0, r.stderr)
man = json.load(open(f"{pkgdir}/ffbridge-update.json"))
check("manifest has version, checksum and image fingerprint", man["version"] == "1.0.99" and len(man["sha256"]) == 64 and len(man["imageHash"]) == 16, man)
names = tarfile.open(f"{pkgdir}/ffbridge-update.tar.gz").getnames()
check("package contains bridge, page, AI code and helper",
      all(any(n.endswith(x) for n in names) for x in ["opt/ffbridge/bin/pibridge", "setup-web/index.html", "opt/ffbridge/ai/ffai_server.py",
                                                        "usr/local/lib/ffbridge/ffsys.py", "etc/systemd/system/ffbridge.service"]), names[:20])
URL = "file://" + pkgdir

# ---------------------------------------------------------------- 1. good update
root, state = os.path.join(tmp, "b1"), os.path.join(tmp, "s1")
fake_board(root)
m = load(root, state)
res = m.update_run(URL)
check("good update: status done", res["state"] == "done", res)
check("good update: new binary installed", open(f"{root}/opt/ffbridge/bin/pibridge").read() == "NEW BINARY")
check("good update: page folder replaced (old file gone)", not os.path.exists(f"{root}/opt/ffbridge/setup-web/obsolete.js")
      and os.path.exists(f"{root}/opt/ffbridge/setup-web/help/help.html"))
check("good update: previous version kept", open(f"{state}/update/previous/opt/ffbridge/bin/pibridge").read() == "OLD BINARY")

# ---------------------------------------------------------------- 2. new version doesn't start -> rollback
root, state = os.path.join(tmp, "b2"), os.path.join(tmp, "s2")
fake_board(root)
os.environ["FFB_UPDATE_TEST_HEALTHY"] = "0"
m = load(root, state)
res = m.update_run(URL)
os.environ["FFB_UPDATE_TEST_HEALTHY"] = "1"
check("broken update: rolled back", res["state"] == "rolled-back", res)
check("broken update: old binary back", open(f"{root}/opt/ffbridge/bin/pibridge").read() == "OLD BINARY")
check("broken update: old page back", open(f"{root}/opt/ffbridge/setup-web/index.html").read() == "old page"
      and os.path.exists(f"{root}/opt/ffbridge/setup-web/obsolete.js"))
check("broken update: files new in that version removed", not os.path.exists(f"{root}/opt/ffbridge/ai/ffai_server.py"))
check("broken update: old helper back", open(f"{root}/usr/local/lib/ffbridge/ffsys.py").read() == "old helper")

# ---------------------------------------------------------------- 3. damaged download
bad = os.path.join(tmp, "bad")
shutil.copytree(pkgdir, bad)
with open(f"{bad}/ffbridge-update.tar.gz", "ab") as f:
    f.write(b"garbage")
root, state = os.path.join(tmp, "b3"), os.path.join(tmp, "s3")
fake_board(root)
m = load(root, state)
res = m.update_run("file://" + bad)
check("damaged download: refused", res["state"] == "failed" and "checksum" in res["message"], res)
check("damaged download: nothing changed", open(f"{root}/opt/ffbridge/bin/pibridge").read() == "OLD BINARY")

# ---------------------------------------------------------------- 4. needs a new SD card image
root, state = os.path.join(tmp, "b4"), os.path.join(tmp, "s4")
fake_board(root)
open(f"{root}/opt/ffbridge/IMAGE_HASH", "w").write("0000000000000000")
m = load(root, state)
res = m.update_run(URL)
check("new image needed: refused with explanation", res["state"] == "image-required", res)
check("new image needed: nothing changed", open(f"{root}/opt/ffbridge/bin/pibridge").read() == "OLD BINARY")

# ---------------------------------------------------------------- 5. package tries to escape its folder
evil = os.path.join(tmp, "evil")
os.makedirs(evil)
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz") as t:
    data = b"pwned"
    ti = tarfile.TarInfo("../../etc/passwd")
    ti.size = len(data)
    t.addfile(ti, io.BytesIO(data))
open(f"{evil}/ffbridge-update.tar.gz", "wb").write(buf.getvalue())
json.dump({**man, "sha256": hashlib.sha256(buf.getvalue()).hexdigest()}, open(f"{evil}/ffbridge-update.json", "w"))
root, state = os.path.join(tmp, "b5"), os.path.join(tmp, "s5")
fake_board(root)
m = load(root, state)
res = m.update_run("file://" + evil)
check("tampered package: refused", res["state"] == "failed" and "unexpected" in res["message"], res)

# ---------------------------------------------------------------- start: only real GitHub release addresses
check("only GitHub release URLs accepted", m.update_start("https://evil.example.com/x")["ok"] is False)

shutil.rmtree(tmp, ignore_errors=True)
print("\nall good" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
