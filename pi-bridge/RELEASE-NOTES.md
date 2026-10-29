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

- Screen layout settings (Settings → General → Screen layout): camera size, side panel right/left/below, where the print status card sits, and an option to keep the whole camera picture on screen. Saved per browser. The side panel now stays beside the camera on normal-width screens.
- Printer network (Settings → Advanced → Printer network, off by default): the board's Wi-Fi becomes a private network for your printers while the board joins your home network by cable. Printers are cut off from the internet; you can allow internet for 1 or 4 hours (e.g. for a firmware update) and it switches itself off again. The board also gives the printers the time.
- Printers that get a new network address are found again by themselves (no more re-entering the IP address).
- Fixed: the bridge could crash when a printer was edited or removed while it was still trying to connect.
