## FlashForge Bridge for Orange Pi Zero 4

**Flash it:** download `ffbridge-orangepi-zero4.img.xz` and write it to a microSD card (8 GB or larger) with
[Raspberry Pi Imager](https://www.raspberrypi.com/software/) ("Use custom") or [balenaEtcher](https://etcher.balena.io/).
You don't need to unzip it first.

**Set up Wi-Fi:** after flashing, take the card out and put it back in. A drive called **FFBRIDGE** appears.
Open `ffbridge-config.txt`, enter `wifi_name=` and `wifi_password=`, then save.
(Using an Ethernet cable instead? Skip this step.)

**Start:** put the card in the board and power it on. Wait 2 minutes, then open **http://ffbridge.local**.
The steps are also in `READ-ME-FIRST.txt` on the card.

Includes: Mainsail + OrcaSlicer support (Creator 5 / 5 Pro, AD5X, Adventurer 5M / 5M Pro),
setup page, Spoolman, Discord, and AI print-failure detection (Obico model, runs on the board).

**Updating:** boards on this version or newer update themselves with one click
(Advanced → System → Updates). Your settings are kept.

## What's new

- One-click updates from the printer screen (Advanced → System → Updates). If a new version doesn't start, the board goes back to the old one by itself.
- Settings backup: download it from Advanced → System, and the board also keeps a copy on the SD card's FFBRIDGE drive. A freshly flashed card restores it automatically.
- Printer errors are shown in plain English with what to do and a link to FlashForge's repair guide.
