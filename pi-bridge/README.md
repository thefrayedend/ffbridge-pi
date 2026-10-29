# FlashForge Pi Bridge

The TV Bridge (Mainsail + OrcaSlicer support for FlashForge Creator 5 / AD5X / 5M printers) as a
**ready-to-flash SD card image for single-board computers**. The first target is the
**Orange Pi Zero 4 (Allwinner A733, 4 GB)**. It adds **AI print-failure detection** using Obico's
open-source model and the printer's own camera.

For the person using it, it works like this: flash the image, type the Wi-Fi details into a text
file on the SD card, power the board on, and open `http://ffbridge.local`. They never touch Linux.

```
pi-bridge/
├── bridge/            Dart server: reuses android-tv-app/source/lib/core unchanged
│   ├── bin/pibridge.dart      entry point (Moonraker/Mainsail per printer + setup page + AI monitor)
│   ├── src/                   setup API, AI monitor, SD-card config, system control
│   ├── web/                   setup page (plain HTML/CSS/JS, no build step)
│   └── test/prediction_check.dart
├── ai/                Local AI service (Python + ONNX Runtime, Obico model) – AGPL-3.0
│   ├── ffai_server.py, requirements.txt, fetch-model.sh
│   └── test/          dummy model + fake service for tests without the real model
├── image/             SD card image builder
│   ├── build-image.sh         stock board image -> FlashForge Bridge image
│   ├── customize.sh           runs inside the image (packages, users, services)
│   ├── rootfs/                systemd units, root helper, NetworkManager/avahi config
│   └── setup-partition/       files on the Windows-readable FFBRIDGE drive
├── github-workflows/  build-image.yml (goes into .github/workflows/ on GitHub)
└── README.md (this file), RELEASE-NOTES.md, LICENSES.txt
```

## What the user gets

| | |
|---|---|
| **Setup page** – `http://ffbridge.local` (port 80) | The TV app's screens in a browser: scan for the printer, enter the pairing code, test, save; Spoolman and Discord. Also new pages for Wi-Fi, AI Watch and System (log, restart, optional password). |
| **Mainsail + OrcaSlicer** – port 7125 (7126, … for more printers) | Same Moonraker emulation as the TV app. OrcaSlicer: host type *Octo/Klipper*, `<board-ip>:7125`. |
| **Wi-Fi from a text file** | The SD card has a small `FFBRIDGE` drive that Windows and macOS can read. Fill in `ffbridge-config.txt` (`wifi_name=`, `wifi_password=`) and it's applied at boot. Hostname, time zone, optional printer and SSH can be set there too. |
| **Fallback hotspot** | With no network after ~90 s, the board opens the Wi-Fi network `FlashForge-Bridge-XXXX` (password `flashforge`). Phones show a "sign in" page that opens the setup page, and the user picks their home Wi-Fi there. |
| **Why isn't it online?** | The board writes `WIFI-STATUS.txt` to the FFBRIDGE drive: connected or not, the reason in plain words (wrong password, name not found / wrong upper-lower case, stray space, password too short, no address from the router), what to change, and the Wi-Fi networks it can see. The setup page's Wi-Fi tab shows the same reason. |
| **Where's my board?** | mDNS name `ffbridge.local`. The board also writes `MY-BRIDGE-ADDRESS.txt` (with its IP) back to the SD card's FFBRIDGE drive. |
| **AI failure detection** | On by default. Checks a camera picture every 10 s while printing. It can alert only (setup page, Mainsail pop-up, Discord with picture) or alert and pause. A "Not a failure" button mutes alerts for the rest of that print. |

## AI failure detection – how it works

* **Model:** Obico's open-source failure detector, a YOLOv2-style network: 416×416 input, 50.5 M
  parameters, **29.3 GFLOPs per picture**, 202 MB ONNX file. It's downloaded from Obico at build
  time and checked against the SHA-256 published in obico-server (`ai/fetch-model.sh`).
* **Runtime:** `ai/ffai_server.py` runs it with ONNX Runtime on the CPU. It listens on localhost
  only and runs at lower priority with a 1.5 GB memory cap, so the bridge stays responsive.
* **Decision logic:** `bridge/src/ai_monitor.dart` is a direct port of Obico's
  `backend/lib/prediction.py`, using the same 1st-gen hyper-parameters: EWM span 12, rolling
  windows 310 / 7200, thresholds 0.38 / 0.78, 30 warm-up frames, escalation factor 1.75. A single
  odd frame can't trigger anything. The 10 s check interval matches what Obico tuned for.
  "Pause" uses the stronger escalated threshold, so it always comes after a warning.
  `test/prediction_check.dart` covers this.
* **Expected speed on the Orange Pi Zero 4:** about **1–2 s per check** on the CPU (2× Cortex-A76
  + 6× A55). That's an estimate from the model size, not yet measured on the board. It's plenty for
  one check every 10 s, even with 2–3 printers. To measure it on the board:
  `sudo -u ffbridge /opt/ffbridge/ai/venv/bin/python /opt/ffbridge/ai/ffai_server.py --benchmark picture.jpg`.
  The `FFAI_THREADS` setting in `/etc/default/ffai` changes how many CPU threads it uses.
* **NPU:** the A733 has a 3 TOPS VeriSilicon VIP9000 NPU. Running this model on it needs a one-time
  conversion with Allwinner's ACUITY toolkit (Docker, x86) to an 8-bit `.nb` file, plus a small
  C++ runner using VIPLite. Radxa measured ~20 ms for YOLOv5s on the same chip. The service
  interface (`POST /detect` → detections) is built so an NPU backend can drop in later without
  touching the bridge. It isn't needed for 10-second checks, so v1 ships the CPU path.
  For a ready-made NPU path, Frigate/Obico both support Rockchip RKNN boards.
* **Ideas taken from Frigate:**
  * a separate detector service behind a small API, so different backends can be swapped in
  * analysing a few frames from a low-rate stream, not the live view
  * only running detection when it matters (here: only while printing)
  * reusing the bridge's single camera connection, so the AI adds no extra stream to the printer

## Building the image (maintainer, one time per release)

Rookies never do this. They download the finished `.img.xz` from the Releases page.

### Option A – GitHub (recommended, nothing to install)

Step-by-step for beginners: see `GITHUB-STEPS.txt` in the `FFBridge-for-GitHub` folder. In short:

1. Make a new public GitHub repository and upload the contents of `FFBridge-for-GitHub`.
2. Create the file `.github/workflows/build-image.yml` there (copy it from
   `pi-bridge/github-workflows/build-image.yml`).
3. Make a release with the tag `base-image` and attach the Orange Pi Zero 4 image you downloaded
   from orangepi.org.
4. Go to Actions → "Build SD card image" → Run workflow. About 30–60 minutes later the finished
   `ffbridge-orangepi-zero4.img.xz` is under Releases → "Latest SD card image".

### Option B – on a Linux PC or WSL2

```bash
sudo apt install fdisk dosfstools mtools e2fsprogs xz-utils rsync python3 curl p7zip-full qemu-user-static binfmt-support
# Dart SDK 3.8+ (cross-compiles to arm64), or pass a ready binary with --bridge-bin
sudo bash pi-bridge/image/build-image.sh --base ~/Downloads/Orangepizero4_x.x.x_debian_bookworm_server.img.xz
# -> pi-bridge/out/ffbridge-orangepi-zero4.img.xz
```

### What the builder does to the stock image

1. Keeps everything before the root filesystem byte for byte (Allwinner boot0 at 8 KiB,
   boot_package at 16400 KiB, any boot partition).
2. Inserts a 64 MB FAT drive labelled **FFBRIDGE** where the root filesystem used to start, and
   moves the root filesystem behind it.
   * The root partition keeps its number (boot scripts often refer to "p1") and its UUIDs, and
     stays physically last.
   * On first boot, `ffbridge-firstboot` grows it to fill the SD card. The vendor's own
     resize services are disabled so the two don't fight over it.
3. Copies in the bridge, the setup page, Mainsail 2.19 and the AI service + model, then runs
   `customize.sh` inside the image:
   * installs NetworkManager, avahi (mDNS), sudo and Python venv
   * creates the `ffbridge` service user
   * locks the vendor's default passwords and turns SSH off (it can be enabled from the config file)
   * enables the services
4. Compresses the result with xz and writes a SHA-256.

`--skip-customize` builds a layout-only image for testing.

## Services on the board

| Unit | Runs as | Purpose |
|---|---|---|
| `ffbridge-firstboot` | root, once | grow the root partition, new SSH host keys, new machine-id |
| `ffbridge-config` | root, each boot | apply `ffbridge-config.txt` (only when it changed; retried if Wi-Fi hardware wasn't ready) |
| `ffbridge-hotspot` | root | setup hotspot when there's no network; retries the saved Wi-Fi every 5 min, but not while a phone is connected to the hotspot (max. 30 min wait); writes `WIFI-STATUS.txt` |
| `ffbridge` | `ffbridge` | the bridge: setup page :80, Mainsail/Moonraker :7125+ |
| `ffai` | `ffbridge` | AI service on 127.0.0.1:3333 |

The bridge never runs as root. Wi-Fi, hostname and reboot go through one helper,
`/usr/local/sbin/ffbridge-helper` (`image/rootfs/usr/local/lib/ffbridge/ffsys.py`). It's the only
command the `ffbridge` user may run with sudo. Data lives in `/var/lib/ffbridge` (same
`ffbridge.json` format as the TV app, plus `pi.json` for AI and the setup password).

## Developing / testing without a board

```bash
# terminal 1 – printer simulator (Creator 5 Pro API + camera)
cd android-tv-app/source && dart tool/c5sim.dart 127.0.0.1
# terminal 2 – AI service with a tiny stand-in model (or the real one from fetch-model.sh)
cd pi-bridge/ai && python3 test/make_dummy_model.py /tmp/dummy.onnx && FFAI_MODEL=/tmp/dummy.onnx python3 ffai_server.py
# terminal 3 – the bridge, setup page on http://localhost:8088
cd pi-bridge/bridge && dart pub get && dart run bin/pibridge.dart --data /tmp/ffdata
# add printer: IP 127.0.0.1, serial SNC5TEST01, code 12345678
```

`ai/test/fake_ai.py` simulates a print that starts failing after N checks, for testing the alert
and pause path end to end. The Wi-Fi and System pages show "not available" on a PC; they only
work on the board.

## Status / still to verify on real hardware

Tested here:

* the bridge, setup API and setup page, against the simulator
* the AI alert → pause → resume → "not a failure" flow
* the prediction maths
* the image builder end to end on a synthetic image (MBR layout, boot-loader bytes preserved,
  FAT drive, packages, Python venv with ONNX Runtime, services, sudo helper running inside the image)

Still to be checked on a real Orange Pi Zero 4:

- [ ] boots from the rebuilt layout (FFBRIDGE drive physically before the root partition)
- [ ] Wi-Fi from `ffbridge-config.txt` with the board's AIC8800 Wi-Fi driver
- [ ] setup hotspot works on that driver (some drivers have no AP mode; Ethernet always works)
- [ ] first-boot resize
- [ ] AI timing (`--benchmark`) and memory use
- [ ] Windows shows the FFBRIDGE drive when the card is inserted (Windows 10 1703+ mounts the
      second partition of a removable card)

Any arm64 Debian/Ubuntu image with an ext4 root partition works as a base, e.g. a BTT Pi or
Raspberry Pi image. Only the model name in the docs is Orange-Pi specific.

## Licenses

See `LICENSES.txt`.

* Bridge and setup page: MIT, like FlashForgeUI.
* Mainsail: GPL-3.0, shipped unmodified.
* The AI service: AGPL-3.0. It ports Obico's pre/post-processing and runs Obico's AGPL model. It
  runs as a separate process and its source ships in the image (`/opt/ffbridge/ai`).
