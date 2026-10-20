// Builds Klipper-style printer objects (as consumed by Mainsail) from FlashForge state.
import 'ff/ff_client.dart';
import 'ff/models.dart';

class MacroDef {
  final String name, description, gcode;
  const MacroDef(this.name, this.description, this.gcode);
}

double _power(Temp t) {
  if (t.target <= 0) return 0;
  final diff = t.target - t.current;
  if (diff > 5) return 1;
  if (diff > 1) return 0.6;
  return 0.35;
}

List<double> _axisMax(FlashForgeClient c) {
  // /detail reports the build volume as e.g. "256X256X256"
  final m = RegExp(r'(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)').firstMatch(c.last?.raw['measure']?.toString() ?? '');
  if (m != null) return [double.parse(m.group(1)!), double.parse(m.group(2)!), double.parse(m.group(3)!), 0];
  if (c.isCreator5) return [256, 256, 256, 0];
  return [220, 220, 220, 0];
}

List<String> extruderNames(int n) => [for (var i = 0; i < n; i++) i == 0 ? 'extruder' : 'extruder$i'];

List<MacroDef> macrosFor(FlashForgeClient c) => [
      const MacroDef('PAUSE', 'Pause the current print', 'PAUSE_BASE'),
      const MacroDef('RESUME', 'Resume the paused print', 'RESUME_BASE'),
      const MacroDef('CANCEL_PRINT', 'Cancel the current print', 'CANCEL_PRINT_BASE'),
      const MacroDef('CLEAR_PLATFORM', 'Tell the printer the build plate was cleared after a finished print', 'CLEAR_PLATFORM'),
      if (c.caps.led) const MacroDef('LED_ON', 'Turn the chamber light on', 'SET_PIN PIN=LED VALUE=1'),
      if (c.caps.led) const MacroDef('LED_OFF', 'Turn the chamber light off', 'SET_PIN PIN=LED VALUE=0'),
      if (c.caps.filtration)
        const MacroDef('FILTRATION', 'Air filtration: MODE=off|internal|external',
            "{% set MODE = params.MODE|default('off')|string %}\nFILTRATION MODE={MODE}"),
      if (c.isCreator5 || c.isAD5X)
        const MacroDef('SET_MATERIAL_SLOT', 'Set slot/toolhead material shown on the printer (COLOR as RRGGBB)',
            "{% set SLOT = params.SLOT|default(1)|int %}\n{% set MATERIAL = params.MATERIAL|default('PLA')|string %}\n{% set COLOR = params.COLOR|default('FFFFFF')|string %}\nSET_MATERIAL_SLOT SLOT={SLOT} MATERIAL={MATERIAL} COLOR={COLOR}"),
      const MacroDef('LEVEL_BEFORE_PRINT', 'Auto bed leveling before each print started from here: ENABLE=1|0',
          '{% set ENABLE = params.ENABLE|default(1)|int %}\nLEVEL_BEFORE_PRINT ENABLE={ENABLE}'),
      const MacroDef('REFRESH_FILES', 'Reload the file list stored on the printer', 'REFRESH_FILES'),
    ];

class StatusBuilder {
  final FlashForgeClient client;
  bool levelBeforePrint;
  StatusBuilder(this.client, {this.levelBeforePrint = false});

  int get toolCount => client.nozzleCount < 1 ? 1 : client.nozzleCount;

  List<String> objectNames() {
    final names = <String>[
      'webhooks',
      'configfile',
      'mcu',
      'gcode_move',
      'print_stats',
      'virtual_sdcard',
      'display_status',
      'pause_resume',
      'idle_timeout',
      'toolhead',
      'motion_report',
      'system_stats',
      'heaters',
      ...extruderNames(toolCount),
      'heater_bed',
      if (client.caps.chamber) 'heater_generic chamber',
      'fan',
      'fan_generic chamber_fan',
      if (client.caps.led) 'output_pin LED',
      if (client.caps.filtration) 'output_pin Filter_Internal',
      if (client.caps.filtration) 'output_pin Filter_External',
      for (final m in macrosFor(client)) 'gcode_macro ${m.name}',
    ];
    return names;
  }

  Map<String, dynamic> configfile() {
    final config = <String, dynamic>{
      'printer': {'kinematics': 'corexy', 'max_velocity': '600', 'max_accel': '20000'},
      'virtual_sdcard': {'path': '~/printer_data/gcodes'},
      'pause_resume': {},
      'display_status': {},
      'heater_bed': {'max_temp': client.isCreator5 ? '120' : '110', 'min_temp': '0'},
      'fan': {},
    };
    final settings = <String, dynamic>{
      'printer': {'kinematics': 'corexy', 'max_velocity': 600.0, 'max_accel': 20000.0, 'square_corner_velocity': 5.0, 'minimum_cruise_ratio': 0.5},
      'virtual_sdcard': {'path': '~/printer_data/gcodes', 'on_error_gcode': ''},
      'pause_resume': {'recover_velocity': 50.0},
      'display_status': {},
      'heater_bed': {'max_temp': client.isCreator5 ? 120.0 : 110.0, 'min_temp': 0.0, 'heater_pin': 'bed', 'sensor_type': 'NTC'},
      'fan': {'pin': 'fan0', 'max_power': 1.0},
      'fan_generic chamber_fan': {'pin': 'fan1', 'max_power': 1.0},
    };
    final nozzle = double.tryParse(RegExp(r'[\d.]+').stringMatch(client.last?.nozzleModel ?? '') ?? '') ?? 0.4;
    for (final e in extruderNames(toolCount)) {
      config[e] = {'max_temp': client.isCreator5 ? '350' : '300', 'min_temp': '0', 'min_extrude_temp': '170', 'nozzle_diameter': '$nozzle'};
      settings[e] = {
        'max_temp': client.isCreator5 ? 350.0 : 300.0,
        'min_temp': 0.0,
        'min_extrude_temp': 170.0,
        'nozzle_diameter': nozzle,
        'filament_diameter': 1.75,
        'max_extrude_only_distance': 100.0,
        'heater_pin': e,
        'sensor_type': 'NTC',
      };
    }
    if (client.caps.chamber) {
      config['heater_generic chamber'] = {'max_temp': '80', 'min_temp': '0'};
      settings['heater_generic chamber'] = {'max_temp': 80.0, 'min_temp': 0.0, 'heater_pin': 'chamber', 'sensor_type': 'NTC'};
    }
    for (final pin in [if (client.caps.led) 'LED', if (client.caps.filtration) 'Filter_Internal', if (client.caps.filtration) 'Filter_External']) {
      config['output_pin $pin'] = {'pin': pin.toLowerCase(), 'pwm': 'False'};
      settings['output_pin ${pin.toLowerCase()}'] = {'pin': pin.toLowerCase(), 'pwm': false, 'value': 0.0, 'shutdown_value': 0.0};
    }
    for (final m in macrosFor(client)) {
      config['gcode_macro ${m.name}'] = {'description': m.description, 'gcode': m.gcode};
      settings['gcode_macro ${m.name.toLowerCase()}'] = {'description': m.description, 'gcode': m.gcode};
    }
    return {'config': config, 'settings': settings, 'save_config_pending': false, 'save_config_pending_items': {}, 'warnings': []};
  }

  /// Full status of every object. [job] supplies print bookkeeping from the bridge.
  Map<String, Map<String, dynamic>> build({
    required bool online,
    required String stateMessage,
    required String filename,
    required double printDuration,
    required double totalDuration,
    required double filamentUsed,
    required String jobState,
    required String jobMessage,
    required int fileSize,
  }) {
    final d = client.last;
    final tools = d?.toolTemps ?? const [Temp(0, 0)];
    final st = d?.state ?? MachineState.unknown;
    final printing = jobState == 'printing' || jobState == 'paused';
    // the firmware resets printProgress to 0 once a job has completed
    final progress = jobState == 'complete' ? 1.0 : (d?.printProgress ?? 0).clamp(0.0, 1.0);
    var activeTool = 0;
    final cs = d?.currentSlot ?? 0;
    if (client.isCreator5 && cs >= 1 && cs <= toolCount) activeTool = cs - 1;
    final extNames = extruderNames(toolCount);
    final s = <String, Map<String, dynamic>>{};
    s['webhooks'] = {'state': online ? 'ready' : 'shutdown', 'state_message': stateMessage};
    s['mcu'] = {
      'mcu_version': '${client.model} ${client.firmware}',
      'mcu_build_versions': 'FlashForge firmware ${client.firmware}',
      'mcu_constants': {'MCU': client.model},
      'last_stats': {'mcu_awake': 0.01, 'mcu_task_avg': 0.0, 'freq': 0},
    };
    s['print_stats'] = {
      'filename': filename,
      'total_duration': totalDuration,
      'print_duration': printDuration,
      'filament_used': filamentUsed,
      'state': jobState,
      'message': jobMessage,
      'info': {
        'total_layer': (d?.targetPrintLayer ?? 0) > 0 ? d!.targetPrintLayer : null,
        'current_layer': printing && (d?.printLayer ?? 0) > 0 ? d!.printLayer : null,
      },
    };
    s['virtual_sdcard'] = {
      'file_path': filename.isEmpty ? null : '~/printer_data/gcodes/$filename',
      'progress': printing || jobState == 'complete' ? progress : 0.0,
      'is_active': jobState == 'printing',
      'file_position': (progress * fileSize).round(),
      'file_size': fileSize,
    };
    s['display_status'] = {'progress': printing || jobState == 'complete' ? progress : 0.0, 'message': jobMessage.isEmpty ? null : jobMessage};
    s['pause_resume'] = {'is_paused': jobState == 'paused'};
    s['idle_timeout'] = {'state': printing ? 'Printing' : 'Ready', 'printing_time': printDuration};
    final zoff = d?.zAxisCompensation ?? 0.0;
    s['gcode_move'] = {
      'speed_factor': (d?.printSpeedAdjust ?? 100) / 100.0,
      'speed': 1500.0,
      'extrude_factor': 1.0,
      'absolute_coordinates': true,
      'absolute_extrude': true,
      'homing_origin': [0.0, 0.0, zoff, 0.0],
      'position': [0.0, 0.0, 0.0, 0.0],
      'gcode_position': [0.0, 0.0, 0.0, 0.0],
    };
    final axisMax = _axisMax(client);
    s['toolhead'] = {
      'homed_axes': client.supportsGcode ? 'xyz' : '',
      'axis_minimum': [0.0, 0.0, 0.0, 0.0],
      'axis_maximum': axisMax,
      'print_time': printDuration,
      'stalls': 0,
      'estimated_print_time': totalDuration,
      'extruder': extNames[activeTool.clamp(0, extNames.length - 1)],
      'position': [0.0, 0.0, 0.0, 0.0],
      'max_velocity': 600.0,
      'max_accel': 20000.0,
      'minimum_cruise_ratio': 0.5,
      'square_corner_velocity': 5.0,
    };
    s['motion_report'] = {'live_position': [0.0, 0.0, 0.0, 0.0], 'live_velocity': 0.0, 'live_extruder_velocity': 0.0, 'steppers': [], 'trapq': []};
    s['system_stats'] = {'sysload': 0.1, 'cputime': totalDuration, 'memavail': 1024 * 1024};
    s['heaters'] = {
      'available_heaters': [...extNames, 'heater_bed', if (client.caps.chamber) 'heater_generic chamber'],
      'available_sensors': [...extNames, 'heater_bed', if (client.caps.chamber) 'heater_generic chamber'],
      'available_monitors': [],
    };
    for (var i = 0; i < extNames.length; i++) {
      final t = i < tools.length ? tools[i] : const Temp(0, 0);
      s[extNames[i]] = {
        'temperature': _r(t.current),
        'target': t.target,
        'power': _power(t),
        'can_extrude': t.current >= 170,
        'pressure_advance': 0.0,
        'smooth_time': 0.04,
        'motion_queue': null,
      };
    }
    final bed = d?.bed ?? const Temp(0, 0);
    s['heater_bed'] = {'temperature': _r(bed.current), 'target': bed.target, 'power': _power(bed)};
    if (client.caps.chamber) {
      final ch = d?.chamber ?? const Temp(0, 0);
      s['heater_generic chamber'] = {'temperature': _r(ch.current), 'target': ch.target, 'power': _power(ch)};
    }
    s['fan'] = {'speed': ((d?.coolingFanSpeed ?? 0) / 100.0).clamp(0.0, 1.0), 'rpm': null};
    s['fan_generic chamber_fan'] = {'speed': ((d?.chamberFanSpeed ?? 0) / 100.0).clamp(0.0, 1.0), 'rpm': null};
    if (client.caps.led) s['output_pin LED'] = {'value': (d?.lightsOn ?? false) ? 1.0 : 0.0};
    if (client.caps.filtration) {
      s['output_pin Filter_Internal'] = {'value': (d?.internalFanOn ?? false) ? 1.0 : 0.0};
      s['output_pin Filter_External'] = {'value': (d?.externalFanOn ?? false) ? 1.0 : 0.0};
    }
    for (final m in macrosFor(client)) {
      s['gcode_macro ${m.name}'] = {};
    }
    if (st == MachineState.unknown && !online) {
      // keep values; webhooks reports the problem
    }
    return s;
  }

  static double _r(double v) => (v * 100).roundToDouble() / 100;
}
