# Notes for a future phone app (read before changing the bridge)

A Flash Bridge phone app (Android first) is planned but **not being built yet**. The rule for now:
**don't go out of the way for the app, but whenever a file is being edited anyway, make that part
app-friendly at the same time** (two birds, one stone).

## What the app is expected to do

1. **Open with / Share** a 3MF or STL from any app or website (MakerWorld, Printables, Discord …)
   straight into the slicer on the board. MakerWorld has no public download API: start with
   share / open-with, not an in-app MakerWorld browser (their terms, and it breaks on redesigns).
2. **Find the board by itself** on the Wi-Fi (mDNS, `<name>.local`, `_http._tcp`).
3. **Push notifications**: print done, paused, filament out, AI failure pause, slice done / failed.
4. Show the **existing web UI** inside the app (WebView); no second user interface.

## App ideas (from the planning talk, roughly in order)

**Version 1 – the "Bambu Handy" feel**
- Open with / Share target for `.3mf`, `.stl`, `.obj` (and `.gcode` / `.gcode.3mf` to print directly):
  tap Download on any model site → pick Flash Bridge → the project opens in Prepare with its plates,
  colours and painting → Slice → Print.
- Board found automatically; several boards / printers listed with their status.
- Web UI inside the app (WebView), full screen, with the app's own back button handling.
- Push notifications: print finished, print paused (by the user, the printer or the AI), filament
  run-out, slice finished / failed. Tapping one opens that printer or plate.
- Sideloaded APK built by GitHub Actions (no Play Store needed to start).

**Later**
- Camera on the lock screen / a home-screen widget: progress, time left, live picture.
- "Print again" from a history of finished prints.
- Quick actions without opening the full UI: pause, resume, stop, lights, filtration.
- MakerWorld in the app (only after checking their terms): browse inside the app with the user's own
  login and catch downloads; until then share / open-with does the same job for every site.
- Spoolman: scan a spool's QR / NFC tag with the phone to load it into a slot.
- Phone-friendly Prepare / Paint (bigger touch targets, simpler paint tools); heavy painting stays a PC job.

**Not planned**
- A second slicer on the phone: slicing stays on the board, the app is the front door.

## What that means when touching bridge code

- **Everything the web page can do goes through `/api/...` and answers JSON** — never logic that
  only works from inside the page. A new feature = an API call the app can make too.
- **Keep JSON field names stable**; add fields rather than renaming or removing them.
  If something has to change, keep the old field for a while.
- **Things worth notifying about** (state changes, finished jobs, errors) should end up in one place
  the app can later listen to (today: Discord messages and `/api/status`). When editing that code,
  prefer a single "event" function both Discord and a future push channel can call.
- **Files from outside**: slicer input should be accepted as an upload (`multipart/form-data`) from
  any client, not only from the page's file picker. Same for printing an existing file.
- **No browser-only assumptions** in the API: no reliance on cookies, page reloads or `localStorage`
  for anything the server needs to know.
- `/api/status` should keep telling a client who it is talking to: bridge name, version, printers.
  When editing it, it is a good place to add a small `api` version number and a `capabilities` list.
- The board speaks plain HTTP on the local network. Android allows that only for listed hosts or
  with `usesCleartextTraffic` — fine for a local app, just don't make anything depend on HTTPS.

## Already there

- The Flash Bridge icon: `branding/flash-bridge-icon.svg` and `branding/icon-1024.png` (use these for the
  app's launcher icon); the web page uses the same icon (`bridge/web/favicon.*`, `bridge/web/icons/`).

- `android-tv-app/` is a Flutter Android app (the older TV bridge): build setup and Android know-how
  exist and an APK can be built by GitHub Actions like the SD card image.
