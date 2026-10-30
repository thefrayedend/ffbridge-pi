## Flash Bridge for Orange Pi Zero 4

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

- **Slicer, built in** (Settings → General → Slicer → Download the slicer engine, once). New **Prepare · Paint · Preview** buttons in the top bar:
  - Prepare: add STL / OBJ / 3MF (MakerWorld, Bambu, Orca projects too), move / rotate / scale, lay on face, auto-orient, arrange, filament per object, quality profile + all print settings.
  - Paint: brush colours onto models (painting from MakerWorld / Orca projects is kept).
  - Preview: slices on the board with the real OrcaSlicer engine and shows the print layer by layer (by filament or line type), print time and filament used. Print… goes straight into the filament check.
  - Only the Flashforge profiles of the printer you have open can be used. A project made for another printer keeps its models and colours but never switches the printer or its settings.
  - Switch the slicer off in the same Settings card to hide it.
- The bridge is now called **Flash Bridge** (the address http://ffbridge.local stays the same).
