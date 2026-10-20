// Translates Klipper / Marlin style G-code (as sent by Mainsail and OrcaSlicer)
// into FlashForge API calls.
import 'bridge.dart';
import 'bridge_state.dart';
import 'moonraker/file_manager.dart' show RpcError;

class GcodeCommand {
  final String raw;
  final String cmd;
  final Map<String, String> params;
  GcodeCommand(this.raw, this.cmd, this.params);

  static GcodeCommand parse(String line) {
    var l = line.trim();
    final sc = l.indexOf(';');
    if (sc >= 0) l = l.substring(0, sc).trim();
    if (l.isEmpty) return GcodeCommand(line, '', {});
    final m = RegExp(r'^(\S+)\s*(.*)$').firstMatch(l)!;
    final cmd = m.group(1)!.toUpperCase();
    final rest = m.group(2)!;
    final params = <String, String>{};
    if (rest.contains('=')) {
      for (final p in RegExp(r'''(\w+)\s*=\s*("([^"]*)"|'([^']*)'|\S+)''').allMatches(rest)) {
        params[p.group(1)!.toUpperCase()] = p.group(3) ?? p.group(4) ?? p.group(2)!;
      }
    } else if (RegExp(r'^[GMT]\d').hasMatch(cmd)) {
      for (final p in RegExp(r'([A-Za-z])([-+]?[\d.]*)').allMatches(rest)) {
        params[p.group(1)!.toUpperCase()] = p.group(2)!;
      }
    }
    return GcodeCommand(line, cmd, params);
  }

  double? num(String k) => params[k] == null ? null : double.tryParse(params[k]!);
}

const gcodeHelp = {
  'M104': 'Set extruder temperature (S<temp> [T<tool>])',
  'M109': 'Set extruder temperature (no wait over LAN)',
  'M140': 'Set bed temperature',
  'M190': 'Set bed temperature (no wait over LAN)',
  'M141': 'Set chamber temperature',
  'M106': 'Set part cooling fan (only while printing)',
  'M107': 'Turn part cooling fan off (only while printing)',
  'M220': 'Set print speed factor',
  'M112': 'Emergency stop (cancels the print and turns heaters off)',
  'SET_HEATER_TEMPERATURE': 'Set a heater target',
  'TURN_OFF_HEATERS': 'Turn off all heaters',
  'SET_FAN_SPEED': 'Set a fan speed (only while printing)',
  'SET_GCODE_OFFSET': 'Live Z offset (Z / Z_ADJUST)',
  'SET_PIN': 'Toggle LED / filtration',
  'PAUSE': 'Pause print',
  'RESUME': 'Resume print',
  'CANCEL_PRINT': 'Cancel print',
  'SDCARD_PRINT_FILE': 'Start a print: FILENAME=<file>',
  'SDCARD_RESET_FILE': 'Clear finished job (clear platform)',
  'CLEAR_PLATFORM': 'Confirm the build plate is clear',
  'FILTRATION': 'MODE=off|internal|external',
  'SET_MATERIAL_SLOT': 'SLOT=1-4 MATERIAL=PLA COLOR=RRGGBB',
  'LEVEL_BEFORE_PRINT': 'ENABLE=1|0',
  'REFRESH_FILES': 'Reload printer file list',
  'STATUS': 'Show printer status',
  'HELP': 'List commands',
  'FIRMWARE_RESTART': 'Reconnect to the printer',
  'RESTART': 'Reconnect to the printer',
};

class GcodeRunner {
  final PrinterBridge b;
  GcodeRunner(this.b);

  Future<void> runScript(String script) async {
    for (final line in script.split('\n')) {
      final c = GcodeCommand.parse(line);
      if (c.cmd.isEmpty) continue;
      await run(c);
    }
  }

  void _ok(bool r, String what) {
    if (!r) throw RpcError(400, 'Printer rejected: $what');
  }

  int _toolFromHeater(String h) {
    final n = h.toLowerCase().trim();
    if (n == 'extruder') return 0;
    final m = RegExp(r'^extruder(\d+)$').firstMatch(n);
    if (m != null) return int.parse(m.group(1)!);
    return -1;
  }

  int get _activeTool {
    final e = b.status['toolhead']?['extruder']?.toString() ?? 'extruder';
    final t = _toolFromHeater(e);
    return t < 0 ? 0 : t;
  }

  Future<void> _setHeater(String heater, double target) async {
    final h = heater.toLowerCase();
    final c = b.client;
    final tool = _toolFromHeater(h);
    if (tool >= 0) {
      if (tool >= b.builder.toolCount) throw RpcError(400, 'Unknown heater $heater');
      _ok(await c.setToolTemp(tool, target), 'set $heater');
    } else if (h == 'heater_bed' || h == 'bed') {
      _ok(await c.setBedTemp(target), 'set bed');
    } else if (h.contains('chamber')) {
      if (!c.caps.chamber) throw RpcError(400, 'This printer has no heated chamber');
      _ok(await c.setChamberTemp(target), 'set chamber');
    } else {
      throw RpcError(400, 'Unknown heater $heater');
    }
    b.gcodeResponse('// $heater target set to ${target.round()}°C');
  }

  Future<void> run(GcodeCommand g) async {
    final c = b.client;
    if (!b.online && !['FIRMWARE_RESTART', 'RESTART', 'HELP', 'STATUS'].contains(g.cmd)) {
      throw RpcError(503, 'Printer is offline');
    }
    switch (g.cmd) {
      case 'M104':
      case 'M109':
        final t = g.params.containsKey('T') ? int.tryParse(g.params['T']!) ?? 0 : _activeTool;
        await _setHeater(t == 0 ? 'extruder' : 'extruder$t', g.num('S') ?? 0);
      case 'M140':
      case 'M190':
        await _setHeater('heater_bed', g.num('S') ?? 0);
      case 'M141':
      case 'M191':
        await _setHeater('chamber', g.num('S') ?? 0);
      case 'SET_HEATER_TEMPERATURE':
        final h = g.params['HEATER'] ?? '';
        await _setHeater(h, g.num('TARGET') ?? 0);
      case 'TURN_OFF_HEATERS':
        for (var i = 0; i < b.builder.toolCount; i++) {
          await c.setToolTemp(i, 0);
        }
        await c.setBedTemp(0);
        if (c.caps.chamber) await c.setChamberTemp(0);
        b.gcodeResponse('// All heaters off');
      case 'M106':
        await _fan('fan', ((g.num('S') ?? 255) / 255.0));
      case 'M107':
        await _fan('fan', 0);
      case 'SET_FAN_SPEED':
        await _fan(g.params['FAN'] ?? 'fan', g.num('SPEED') ?? 0);
      case 'M220':
        final s = (g.num('S') ?? 100).round();
        _requirePrinting('Speed factor');
        _ok(await c.printerControl(speed: s), 'speed');
        b.gcodeResponse('// Speed factor set to $s%');
      case 'M221':
        throw RpcError(400, 'Flow rate (M221) is not supported by the FlashForge LAN API');
      case 'SET_GCODE_OFFSET':
        final cur = c.last?.zAxisCompensation ?? 0;
        double? z;
        if (g.params.containsKey('Z_ADJUST')) z = cur + (g.num('Z_ADJUST') ?? 0);
        if (g.params.containsKey('Z')) z = g.num('Z');
        if (z == null) {
          b.gcodeResponse('// Only the Z offset can be changed');
          return;
        }
        _requirePrinting('Z offset');
        z = (z * 1000).roundToDouble() / 1000;
        _ok(await c.printerControl(zOffset: z), 'z offset');
        b.gcodeResponse('// Z offset: ${z.toStringAsFixed(3)}');
      case 'SET_PIN':
        final pin = (g.params['PIN'] ?? '').toLowerCase();
        final v = (g.num('VALUE') ?? 0) > 0;
        if (pin == 'led') {
          _ok(await c.setLed(v), 'LED');
        } else if (pin == 'filter_internal' || pin == 'filter_external') {
          // the printer runs one filtration mode at a time
          _ok(await c.setFiltration(internal: pin == 'filter_internal' && v, external: pin == 'filter_external' && v), 'filtration');
        } else {
          throw RpcError(400, 'Unknown pin $pin');
        }
      case 'LED_ON':
        _ok(await c.setLed(true), 'LED');
      case 'LED_OFF':
        _ok(await c.setLed(false), 'LED');
      case 'FILTRATION':
        final mode = (g.params['MODE'] ?? 'off').toLowerCase();
        _ok(await c.setFiltration(internal: mode == 'internal', external: mode == 'external'), 'filtration');
        b.gcodeResponse('// Filtration: $mode');
      case 'PAUSE':
      case 'M25':
        _ok(await c.pause(), 'pause');
      case 'RESUME':
      case 'M24':
        _ok(await c.resume(), 'resume');
      case 'CANCEL_PRINT':
      case 'M26':
        _ok(await c.cancel(), 'cancel');
      case 'M112':
      case 'EMERGENCY_STOP':
        await emergencyStop();
      case 'SDCARD_PRINT_FILE':
        final f = g.params['FILENAME'];
        if (f == null) throw RpcError(400, 'FILENAME required');
        await b.startPrint(f);
      case 'SDCARD_RESET_FILE':
      case 'CLEAR_PLATFORM':
        _ok(await c.clearPlatform(), 'clear platform');
        b.gcodeResponse('// Build plate marked as clear');
      case 'SET_MATERIAL_SLOT':
        final slot = int.tryParse(g.params['SLOT'] ?? '1') ?? 1;
        final mat = (g.params['MATERIAL'] ?? 'PLA').toUpperCase();
        final col = g.params['COLOR'] ?? 'FFFFFF';
        if (!(c.isCreator5 || c.isAD5X)) throw RpcError(400, 'This printer has no material station');
        _ok(await c.configureSlot(slot, mat, col), 'material slot');
        b.gcodeResponse('// Slot $slot set to $mat #${col.replaceAll('#', '')}');
      case 'LEVEL_BEFORE_PRINT':
        final en = (g.num('ENABLE') ?? 1) > 0;
        b.cfg.levelBeforePrint = en;
        b.app.save();
        b.gcodeResponse('// Bed leveling before print: ${en ? 'ON' : 'OFF'}');
      case 'REFRESH_FILES':
        await b.refreshPrinterFiles();
        b.gcodeResponse('// File list refreshed (${b.files.printerFiles.length} files on printer)');
      case 'FIRMWARE_RESTART':
      case 'RESTART':
        await b.reconnect();
      case 'STATUS':
      case 'M115':
        final d = c.last;
        b.gcodeResponse('// ${c.model} "${c.name}" firmware ${c.firmware} at ${b.cfg.ip}\n'
            '// state=${d?.status ?? 'offline'} progress=${((d?.printProgress ?? 0) * 100).toStringAsFixed(1)}% '
            'layer ${d?.printLayer ?? 0}/${d?.targetPrintLayer ?? 0}');
      case 'HELP':
        b.gcodeResponse(gcodeHelp.entries.map((e) => '// ${e.key}: ${e.value}').join('\n'));
      case 'M117':
      case 'M118':
      case 'RESPOND':
        b.gcodeResponse('// ${g.params['MSG'] ?? g.raw.substring(4).trim()}');
      default:
        if (c.supportsGcode) {
          final r = await c.gcode(g.raw.trim());
          if (r == null) throw RpcError(400, 'No reply from printer for ${g.cmd}');
          b.gcodeResponse(r.trim().split('\n').map((l) => '// $l').join('\n'));
        } else {
          throw RpcError(400, '${g.cmd} is not available: the ${c.model.isEmpty ? 'printer' : c.model} LAN API does not accept raw G-code '
              '(motion, homing and extrusion must be done on the printer screen). Type HELP for supported commands.');
        }
    }
  }

  void _requirePrinting(String what) {
    if (b.jobState != 'printing' && b.jobState != 'paused') {
      throw RpcError(400, '$what can only be changed while a print is running (FlashForge API limitation)');
    }
  }

  Future<void> _fan(String fan, double speed) async {
    _requirePrinting('Fan speed');
    final pct = (speed.clamp(0.0, 1.0) * 100).round();
    final f = fan.toLowerCase();
    if (f == 'fan' || f.contains('part') || f.contains('cool')) {
      _ok(await b.client.printerControl(coolingFan: pct), 'fan');
    } else if (f.contains('chamber')) {
      _ok(await b.client.printerControl(chamberFan: pct), 'fan');
    } else {
      throw RpcError(400, 'Unknown fan $fan');
    }
    b.gcodeResponse('// $fan set to $pct%');
  }

  Future<void> emergencyStop() async {
    final c = b.client;
    if (b.jobState == 'printing' || b.jobState == 'paused') await c.cancel();
    for (var i = 0; i < b.builder.toolCount; i++) {
      await c.setToolTemp(i, 0);
    }
    await c.setBedTemp(0);
    if (c.caps.chamber) await c.setChamberTemp(0);
    b.gcodeResponse('!! Emergency stop: print cancelled and heaters turned off');
  }

  static Map<String, dynamic> commandsHelp(PrinterBridge b) => {
        for (final e in gcodeHelp.entries) e.key: {'help': e.value},
        for (final m in macrosFor(b.client)) m.name: {'help': m.description},
      };
}
