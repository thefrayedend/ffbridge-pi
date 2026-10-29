// Plain-English explanations of FlashForge printer error codes.
//
// Source: FlashForge's official error code lists (wiki.flashforge.com) for the
// Adventurer 5M series, AD5X and Creator 5 series, rewritten in plain words.
// The Creator 5 uses its own numbering: the same number can mean something else
// there (e.g. E0005, E0123), so the lookup depends on the printer family.

class PrinterError {
  final String code; // "E0012"
  final String title; // short, plain words
  final String fix; // what to do, most likely cause first
  final String wikiUrl; // the official page with videos for repairs
  const PrinterError(this.code, this.title, this.fix, this.wikiUrl);

  Map<String, dynamic> toJson() => {'code': code, 'title': title, 'fix': fix, 'wikiUrl': wikiUrl};
}

const _wiki5m = 'https://wiki.flashforge.com/en/adventurer-series/error_code_adventurer_5m';
const _wikiAd5x = 'https://wiki.flashforge.com/en/ad5x/error_code_list_ad5x';
const _wikiC5 = 'https://wiki.flashforge.com/en/creator-series/creator-5-series/error_code_creator_5';

/// "E0012", "0012", "12", "e12" -> "E0012". Empty / "0" -> "".
String normalizeErrorCode(String raw) {
  final digits = raw.replaceAll(RegExp(r'[^0-9]'), '');
  if (digits.isEmpty || int.tryParse(digits) == 0) return '';
  return 'E${digits.padLeft(4, '0')}';
}

/// [family]: 'creator5', 'ad5x' or anything else (Adventurer 5M / 5M Pro).
/// Returns null when the printer reports no error. Unknown codes still get a helpful answer.
PrinterError? explainError(String raw, String family) {
  final code = normalizeErrorCode(raw);
  if (code.isEmpty) return null;
  final c5 = family == 'creator5';
  final wiki = c5 ? _wikiC5 : (family == 'ad5x' ? _wikiAd5x : _wiki5m);
  List<String>? e;
  if (c5) {
    e = _creator5[code];
  } else {
    if (family == 'ad5x') e = _ad5xOnly[code];
    e ??= _adventurer[code];
  }
  if (e == null) {
    return PrinterError(code, 'Printer error $code',
        'This code isn\'t in FlashForge\'s public list yet. Restart the printer; if it comes back, copy the logs to a USB stick on the printer screen and contact FlashForge support.', wiki);
  }
  return PrinterError(code, e[0], e[1], wiki);
}

const _feedFix = 'Check that the filament isn\'t tangled or caught on the spool, then resume. If it is stuck in the 4-in-1 connector or guide tube, '
    'cancel the print and clear it. Loading a fresh spool can push leftover filament through.';
const _retractFix = 'Usually the cutter didn\'t cut the filament, or a broken piece is stuck in the extruder. While paused, remove the broken '
    'filament (or replace a worn cutter and cut the filament by hand), then resume.';
const _logsFix = 'Turn off "Arc fitting" in your slicer and re-slice — it creates lots of tiny moves that can overload the printer. Also re-seat '
    'the extruder board cable and restart. If it keeps happening, copy the logs on the printer screen and contact FlashForge support.';
const _replaceFix = 'Usually a hardware fault. Restart the printer first; if it comes back, check the cable named in the message and contact FlashForge support.';

/// Adventurer 5M / 5M Pro and AD5X (shared numbering).
const Map<String, List<String>> _adventurer = {
  'E0001': ['Move out of range', 'The file asked the printer to move past its edges. Make sure the right printer was picked in the slicer, then re-slice.'],
  'E0002': ['Lost contact with the print head board', 'Usually a loose or damaged extruder cable. Turn the printer off, re-seat the extruder cable at both ends and restart.'],
  'E0003': ['Motor driver error', 'Restart the printer. If it comes back, a motor driver chip on the mainboard (X/Y/Z) or the extruder board is faulty.'],
  'E0004': ['Motor driver communication error', 'Restart the printer. If it comes back, a motor driver on the mainboard or extruder board needs replacing.'],
  'E0005': ['Printer controller not connecting', 'Temperatures and positions show 0 after power-on. Check the extruder cable; otherwise the extruder board or mainboard is faulty.'],
  'E0006': ['Nozzle temperature reading too low', 'The nozzle temperature sensor isn\'t reading. Check the extruder cable; otherwise the nozzle heating assembly needs replacing.'],
  'E0007': ['Nozzle not heating', 'The nozzle can\'t reach temperature. Check the heater wire and nozzle cable; the nozzle assembly may need replacing.'],
  'E0008': ['Second nozzle not heating', 'The nozzle can\'t reach temperature. Check the heater wire and nozzle cable; the nozzle assembly may need replacing.'],
  'E0009': ['Bed not heating', 'The bed can\'t reach temperature. Check the bed cable is plugged in firmly; otherwise the heated bed or mainboard is faulty.'],
  'E0010': ['Chamber not heating', 'The chamber can\'t reach temperature. Check the heater cable; otherwise the chamber heater or mainboard is faulty.'],
  'E0011': ['Printer error — restart needed', 'Communication inside the printer was interrupted during printing. Restart the printer. If it repeats, re-seat or replace the extruder cable.'],
  'E0012': ['X-axis couldn\'t find home', 'Something is blocking the print head\'s path (often a drooping cable). Clear it and tidy the wiring, then retry.'],
  'E0013': ['Y-axis couldn\'t find home', 'Something is blocking the print head\'s path (often a drooping cable). Clear it and tidy the wiring, then retry.'],
  'E0014': ['Z-axis couldn\'t find home', 'Check nothing blocks the bed\'s movement and that the homing sensor cable is plugged in at both ends. A clicking sound means the sensor isn\'t triggering.'],
  'E0015': ['Nozzle temperature sensor fault', 'Seen when resuming after a power cut: the nozzle temperature sensor is disconnected. The nozzle needs replacing.'],
  'E0016': ['Bed temperature sensor fault', 'Seen when resuming after a power cut: check the bed cable is plugged in; otherwise the heated bed needs replacing.'],
  'E0017': ['Printing too fast for the printer', 'The printer can\'t keep up with the commands. Lower the print speed (e.g. 50 %) or reduce the slicing resolution.'],
  'E0018': ['Language setup failed', 'Restore factory settings on the printer, then choose your language again.'],
  'E0019': ['USB stick can\'t be read', 'Reformat the USB stick as FAT32 and try again.'],
  'E0020': ['Camera video service failed', 'The camera is switched off, missing or faulty. Turn the camera on in the printer settings and restart.'],
  'E0021': ['Camera couldn\'t be turned on', 'Restart the printer. Then check the camera cable; the camera may need replacing.'],
  'E0022': ['Printer storage is full', 'Delete old files, photos or videos on the printer to free up space.'],
  'E0028': ['File copy failed', 'The USB stick was removed too early, or storage is full. Wait for the print screen before removing the stick and free up space.'],
  'E0029': ['File download failed', 'Remove special characters from the file name and re-send. A weak Wi-Fi signal can also cause this.'],
  'E0041': ['Bed leveling sensor can\'t reset', 'Retry once and restart the printer. If it persists, the leveling sensor wiring under the bed is loose or damaged.'],
  'E0042': ['Bed leveling sensor not triggered', 'Re-level. If the bed nuts are very tight, loosen all four by 1–2 turns. Otherwise the leveling sensor may be damaged.'],
  'E0043': ['Bed leveling sensor triggered too early', 'Something touched the bed while it was rising. Clear any objects from the bed and nozzle, then re-level.'],
  'E0046': ['Bed temperature control error', 'The bed temperature sensor or its cable is faulty. Check the bed cable; the heated bed may need replacing.'],
  'E0047': ['Bed took too long to heat', 'Check the bed cable is plugged in firmly. Otherwise the heated bed or its cable is faulty.'],
  'E0048': ['Nozzle temperature control error', 'Check the hot end is installed properly. Otherwise its temperature sensor is faulty.'],
  'E0075': ['Nozzle too low', 'The extruder isn\'t seated properly. Remove and reinstall it.'],
  'E0076': ['Nozzle too high', 'The extruder isn\'t seated properly. Remove and reinstall it.'],
  'E0077': ['Chamber took too long to heat', 'Check the air outlet isn\'t blocked. A very cold room can also cause this.'],
  'E0078': ['Chamber heater fan (left) too slow', 'Something is stuck in the left chamber fan. Clean it; otherwise the fan needs replacing.'],
  'E0079': ['Chamber heater fan (right) too slow', 'Something is stuck in the right chamber fan. Clean it; otherwise the fan needs replacing.'],
  'E0080': ['Chamber temperature reading wrong', 'The air outlet temperature sensor or its cable is faulty.'],
  'E0083': ['Air filter fan too slow or stopped', 'Something is stuck in the filter fan. Clean it; otherwise the fan needs replacing.'],
  'E0088': ['Non-original build plate detected', 'The printer doesn\'t recognise the build plate. Use the original plate for this printer for best results.'],
  'E0089': ['First-layer problem detected', 'The printer\'s scanner saw defects in the first layer. Look at the camera / print and decide whether to continue. Re-leveling and cleaning the nozzle help.'],
  'E0100': ['Slot 1 couldn\'t feed filament', _feedFix],
  'E0101': ['Slot 2 couldn\'t feed filament', _feedFix],
  'E0102': ['Slot 3 couldn\'t feed filament', _feedFix],
  'E0103': ['Slot 4 couldn\'t feed filament', _feedFix],
  'E0104': ['Slot 1 couldn\'t pull filament back', _retractFix],
  'E0105': ['Slot 2 couldn\'t pull filament back', _retractFix],
  'E0106': ['Slot 3 couldn\'t pull filament back', _retractFix],
  'E0107': ['Slot 4 couldn\'t pull filament back', _retractFix],
  'E0108': ['Filament didn\'t reach the extruder', 'The filament is tangled or the spool is stuck. While paused, free it so it runs smoothly into the extruder, then resume.'],
  'E0109': ['Filament station roller not moving', 'The filament is tangled or the nozzle is clogged. While paused, free the filament; if the nozzle is clogged, let it cool and clear it.'],
  'E0110': ['Filament type doesn\'t match the file', 'The material set for the slot doesn\'t match what the file was sliced with. Change the slot\'s material (tap the slot on this screen) or pick another slot.'],
  'E0111': ['Bed leveling data looks wrong', 'Clean the bed and the nozzle, then re-level. If it persists, the bed may be badly out of level.'],
  'E0112': ['Bed leveling triggered too early', 'Clean the bed and the nozzle and check the extruder is seated properly. Loose bed nuts can also cause this.'],
  'E0116': ['Printer software error (priming)', _logsFix],
  'E0117': ['Printer software error (flush)', _logsFix],
  'E0118': ['File contains a bad command', 'Delete the file from the printer and send it again; if that doesn\'t help, re-slice it.'],
  'E0119': ['Printer timing error', _logsFix],
  'E0120': ['Printer restarted unexpectedly', 'The printer\'s configuration may be damaged. Contact FlashForge support for a firmware update.'],
  'E0121': ['Vibration calibration data missing', 'Run the vibration compensation (input shaping) calibration again. If it persists, the nozzle board is faulty.'],
  'E0122': ['Nozzle temperature error', 'Re-seat the heater and sensor wires on the hot end. Otherwise the heating assembly needs replacing.'],
  'E0123': ['Bed temperature error', 'Re-seat the flat cable under the bed. Otherwise the heated bed needs replacing.'],
};

/// AD5X-only codes (and AD5X's own meaning of E0112).
const Map<String, List<String>> _ad5xOnly = {
  'E0112': ['Bed leveling triggered too early', 'Clean the bed and the nozzle and check the extruder is seated properly. Loose bed nuts can also cause this.'],
  'E0113': ['Filament stuck in the extruder', 'Filament didn\'t retract fully or a broken piece is stuck above the extruder. Remove the 4-in-1 tube, clear the filament, and check the extruder\'s filament sensor.'],
  'E0114': ['Filament station couldn\'t home', 'Something may block the station\'s home sensor. If clearing it doesn\'t help, a motor or the station board is faulty — contact FlashForge support.'],
  'E0115': ['First-layer scanner couldn\'t focus', 'Clean the scanner window and restart the printer. If it persists, contact FlashForge support.'],
};

/// Creator 5 / 5 Pro numbering.
const Map<String, List<String>> _creator5 = {
  'E0002': ['Lost contact with the mainboard', 'Re-install the firmware from a USB stick. If that doesn\'t help, the mainboard is faulty.'],
  'E0005': ['Printer not ready — check wiring', 'The extruder mount cable isn\'t connected properly. Re-seat it.'],
  'E0012': ['X-axis couldn\'t find home', 'A cable is sagging or something blocks the print head\'s path. Clear it and tidy the wiring.'],
  'E0013': ['Y-axis couldn\'t find home', 'A cable is sagging or something blocks the print head\'s path. Clear it and tidy the wiring.'],
  'E0014': ['Z-axis couldn\'t find home', 'Something blocks the bed\'s movement. Clear it and tidy the wiring.'],
  'E0021': ['Camera not found', 'Restart the printer. If it persists, the camera needs replacing.'],
  'E0051': ['Couldn\'t pick up tool 1', 'Something is stuck between the tool mount and tool 1. Clean both.'],
  'E0052': ['Couldn\'t pick up tool 2', 'Something is stuck between the tool mount and tool 2. Clean both.'],
  'E0053': ['Couldn\'t pick up tool 3', 'Something is stuck between the tool mount and tool 3. Clean both.'],
  'E0054': ['Couldn\'t pick up tool 4', 'Something is stuck between the tool mount and tool 4. Clean both.'],
  'E0063': ['Nozzle 1 heating error', 'Nozzle 1\'s temperature sensor is faulty — replace that nozzle.'],
  'E0064': ['Nozzle 2 heating error', 'Nozzle 2\'s temperature sensor is faulty — replace that nozzle.'],
  'E0065': ['Nozzle 3 heating error', 'Nozzle 3\'s temperature sensor is faulty — replace that nozzle.'],
  'E0066': ['Nozzle 4 heating error', 'Nozzle 4\'s temperature sensor is faulty — replace that nozzle.'],
  'E0077': ['Chamber heating error', 'The air outlet is blocked. Clean it.'],
  'E0123': ['Bed heating error', 'The heated bed is damaged and needs replacing.'],
  'E0125': ['Lost contact with the tool dock heater board', 'The tool dock cable is damaged. Re-seat or replace it.'],
  'E0127': ['Tool 1 not in the dock', 'Tool 1 isn\'t installed. Put it in its dock.'],
  'E0128': ['Tool 2 not in the dock', 'Tool 2 isn\'t installed. Put it in its dock.'],
  'E0129': ['Tool 3 not in the dock', 'Tool 3 isn\'t installed. Put it in its dock.'],
  'E0130': ['Tool 4 not in the dock', 'Tool 4 isn\'t installed. Put it in its dock.'],
  'E0131': ['Tool 1 already docked — can\'t release', 'Tool 1\'s nozzle board is faulty.'],
  'E0132': ['Tool 2 already docked — can\'t release', 'Tool 2\'s nozzle board is faulty.'],
  'E0133': ['Tool 3 already docked — can\'t release', 'Tool 3\'s nozzle board is faulty.'],
  'E0134': ['Tool 4 already docked — can\'t release', 'Tool 4\'s nozzle board is faulty.'],
  'E0135': ['Couldn\'t release tool 1', 'Tool 1\'s nozzle board is faulty.'],
  'E0136': ['Couldn\'t release tool 2', 'Tool 2\'s nozzle board is faulty.'],
  'E0137': ['Couldn\'t release tool 3', 'Tool 3\'s nozzle board is faulty.'],
  'E0138': ['Couldn\'t release tool 4', 'Tool 4\'s nozzle board is faulty.'],
  'E0139': ['Tool mount sensor not triggered', 'A tool\'s nozzle board is faulty.'],
  'E0140': ['Tool dock sensor not triggered', 'A tool\'s nozzle board is faulty.'],
  'E0141': ['Tool mount sensor stuck on', 'A tool\'s nozzle board is faulty.'],
  'E0142': ['Tool dock sensor stuck on', 'A tool\'s nozzle board is faulty.'],
  'E0143': ['Problem after picking up a tool', 'Something is stuck between the tool mount and the nozzle. Clean both.'],
  'E0144': ['Problem after releasing a tool', 'The board in the tool mount is faulty.'],
  'E0145': ['Tool lock motor problem', 'The board in the tool mount is faulty.'],
  'E0146': ['Tool unlock sensor not triggered', 'The board in the tool mount is faulty.'],
  'E0147': ['Build plate still on during calibration', 'Take the build plate off for this calibration, then retry.'],
  'E0148': ['Bed is too far out of level', 'Clean the bed. If it persists, the bed is mounted at too steep an angle — adjust it by hand.'],
  'E0149': ['Bed sensor not triggered', 'The bed leveling sensor may be damaged.'],
  'E0150': ['Homing took too long', 'Home the printer again.'],
  'E0151': ['Bed probe triggered too early', 'The bed leveling sensor may be damaged.'],
  'E0152': ['Leveling measurements inconsistent', 'Something was vibrating nearby. Clean the bed and nozzle, keep the printer still, and level again.'],
  'E0153': ['Nozzle offset measurements inconsistent', 'Something was vibrating nearby. Clean the sensor and nozzle, keep the printer still, and try again.'],
  'E0155': ['X limit switch stuck on', 'The X limit switch is damaged.'],
  'E0156': ['Y limit switch stuck on', 'The Y limit switch is damaged.'],
  'E0157': ['Z limit stuck on', 'The bed leveling sensor is damaged.'],
  'E0159': ['Homing error', 'An X/Y/Z motor may be damaged.'],
  'E0160': ['Can\'t release tool — homing failed', 'The printer thinks a different tool is picked up than the real one. Check which tool is on the mount.'],
  'E0161': ['Bed sensor position wrong', 'Home the printer again.'],
  'E0162': ['Paused — filament ran out', 'Load new filament, then resume the print.'],
  'E0163': ['Paused — nozzle clog detected', 'Clear the nozzle (needle or cold pull), then resume.'],
  'E0165': ['Tool not installed — can\'t print', 'The tool this print needs isn\'t installed. Put it back in its dock.'],
  'E0166': ['Print file problem', 'The file isn\'t sliced properly or is damaged. Re-slice it.'],
  'E0167': ['Build plate missing', 'Put the build plate on, then start again.'],
  'E0168': ['Build plate missing (leveling)', 'Put the build plate on, then level again.'],
  'E0169': ['File sliced for a different printer', 'Select the Creator 5 in your slicer and re-slice.'],
  'E0170': ['Lost contact with the main controller', 'The mainboard may be damaged. Restart; if it persists, contact FlashForge support.'],
  'E0171': ['Lost contact with the tool mount', 'The tool mount cable may be damaged. Re-seat or replace it.'],
  'E0172': ['Lost contact with the heater board', 'The tool dock cable may be damaged. Re-seat or replace it.'],
  'E0173': ['Lost contact with the bed board', 'The bed cable may be damaged. Re-seat or replace it.'],
  'E0174': ['Couldn\'t copy logs', 'The USB stick was removed too early or is full. Free up space and try again.'],
  'E0175': ['File uses more than 4 colours', 'The Creator 5 has 4 tools. Re-slice with at most 4 filaments.'],
  'E0176': ['File moves out of range', 'Re-slice for the Creator 5.'],
  'E0999': ['Unknown printer error', _replaceFix],
};
