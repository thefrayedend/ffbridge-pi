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
  - Preview: slices on the board with the real OrcaSlicer engine and shows the print layer by layer (by filament or line type), print time and filament used. Print… goes straight into the filament check.
  - Plates, like OrcaSlicer: several plates side by side (tabs over the 3D view), drag models between them or use "Move to", arrange spills onto the next plate, projects open with all their plates, and every plate is sliced / previewed / printed on its own ("Slice all plates" too).
  - Paint tools like OrcaSlicer: circle, sphere, triangle, height range, fill with edge detection (smart fill) and gap fill, Shift to erase, section view, filament remap — for colours, support enforcers / blockers (with overhang highlighting) and seam enforcers / blockers.
  - Only the Flashforge profiles of the printer you have open can be used. A project made for another printer keeps its models and colours but never switches the printer or its settings.
  - Switch the slicer off in the same Settings card to hide it.
- **Projects from other printers open properly:** every model lands on a plate (the project's own bed size is read; models beside the plates get their own plate), its colours come along, and its support / infill / wall / brim settings are kept.
- **Drag models** with the mouse or a finger, also onto other plates; dragging past the last plate makes a new one. The add-plate button is now labelled **+ Plate**.
- **More colours than heads:** up to 16 filaments per project. Each plate is sliced with only the colours it uses, so plates can use different spools. A plate with more colours than the printer holds asks which filament prints each extra colour (or cancel and repaint).
- Slicing no longer stops on painted supports when Supports is off (they are left out, with a note), and the prime tower is placed in a free spot on the plate instead of hanging off the back.
- **Much faster opening of big projects** (a 9-colour MakerWorld project: 67 s → 18 s; a 4.7-million-triangle scan: 89 s → 23 s), and the page stays responsive while it works. Plates pack for slicing 3× faster. Big previews (millions of lines) use a fraction of the memory.
- **Lighter G-code** (Quality card, Auto): detailed plates (200k+ triangles) are sliced with 0.05 mm paths and straight moves instead of arcs. Measured on a 1M-triangle painted helmet: the engine's peak memory went from 2.5 GB to 1.7 GB, same print (even 40 min faster). Before, that plate ran the 4 GB board out of memory.
- **New project** (Plate card): removes every model, plate and slice to start over; settings stay.
- If the board runs out of memory while slicing, only the slice stops (the bridge keeps running) and the page says so instead of waiting forever. Compressed memory (zram) now turns on even when the system already uses zram0.
- **Save project** (Plate card): all plates, positions, filaments and painting as one 3MF, to open here again or in OrcaSlicer / Bambu Studio.
- **Mirror** (X), **Ctrl+D** duplicate, **arrow keys** nudge, size in **mm** fields; stale slice results are cleaned off the SD card; slicing refuses when the card is nearly full instead of failing halfway.
- **Infill filament**, also for multi-colour prints (stock OrcaSlicer can't): the inside of the models in one filament (e.g. white), the colours stay on the outside as a ~3 mm skin.
- **Prime tower fits better:** placed by the models' real outline; when the usual cone-shaped tower (it widens with the print height) has no room, a ribbed or plain one is used.
- **Very detailed models open:** models with millions of triangles (scans, sculpts) are simplified to about 1 million when opened, keeping the shape within 0.05 mm and the painting exactly. When the models fill the plate, a Creator 5 prints without the prime tower.
- **Slicing on the board is lighter and safer:**
  - The AI failure detection pauses while the slicer works (it holds up to 1.5 GB of memory) and starts again by itself shortly after. Prints are not watched during that time.
  - The slicer uses at most 3 cores (the 2 fast ones first), so the bridge and web pages stay responsive.
  - Compressed swap in memory (zram) gives big slices room; nothing is written to the SD card.
  - If memory still runs out, only the slicer is stopped and you get a clear message, never the bridge.
  - The slicer engine is ~25% smaller (debug data and unused libraries removed; same G-code).
- The bridge is now called **Flash Bridge** (the address http://ffbridge.local stays the same).
