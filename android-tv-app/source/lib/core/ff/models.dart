// Data models for the FlashForge HTTP API (port 8898).
import 'dart:math' as math;
// Ported from @ghosttypes/ff-api (MachineInfo / ff-models).

const pid5M = 35, pid5MPro = 36, pidAD5X = 38, pidCreator5 = 40, pidCreator5Pro = 41;

const pidModelNames = {
  pid5M: 'Adventurer 5M',
  pid5MPro: 'Adventurer 5M Pro',
  pidAD5X: 'AD5X',
  pidCreator5: 'Creator 5',
  pidCreator5Pro: 'Creator 5 Pro',
};

enum MachineState { ready, busy, calibrating, error, heating, printing, pausing, paused, cancelled, completed, unknown }

MachineState parseMachineState(String s) {
  switch (s.toLowerCase()) {
    case 'ready':
      return MachineState.ready;
    case 'busy':
    case 'downloading':
      return MachineState.busy;
    case 'calibrate_doing':
      return MachineState.calibrating;
    case 'error':
      return MachineState.error;
    case 'heating':
      return MachineState.heating;
    case 'printing':
      return MachineState.printing;
    case 'pausing':
      return MachineState.pausing;
    case 'pause':
    case 'paused':
      return MachineState.paused;
    case 'cancel':
      return MachineState.cancelled;
    case 'completed':
      return MachineState.completed;
    default:
      return MachineState.unknown;
  }
}

class Temp {
  final double current;
  final double target;
  const Temp(this.current, this.target);
  Map<String, dynamic> toJson() => {'current': current, 'target': target};
}

class SlotInfo {
  final int slotId;
  final bool hasFilament;
  final String materialName;
  final String materialColor;
  SlotInfo(this.slotId, this.hasFilament, this.materialName, this.materialColor);
  Map<String, dynamic> toJson() =>
      {'slotId': slotId, 'hasFilament': hasFilament, 'materialName': materialName, 'materialColor': materialColor};
}

double _d(dynamic v) => v is num ? v.toDouble() : (v is String ? double.tryParse(v) ?? 0 : 0);
int _i(dynamic v) => v is num ? v.toInt() : (v is String ? int.tryParse(v) ?? 0 : 0);
String _s(dynamic v) => v == null ? '' : v.toString();

/// Parsed /detail response.
class PrinterDetail {
  final Map<String, dynamic> raw;
  PrinterDetail(this.raw);

  int? get pid => raw['pid'] is num ? (raw['pid'] as num).toInt() : null;
  String get name => _s(raw['name']);
  String get model => _s(raw['model']).isNotEmpty ? _s(raw['model']) : (pidModelNames[pid] ?? name);
  String get firmwareVersion => _s(raw['firmwareVersion']);
  String get status => _s(raw['status']);
  MachineState get state => parseMachineState(status);

  bool get hasMatlStation =>
      raw['hasMatlStation'] == true ||
      _i((raw['matlStationInfo'] as Map?)?['slotCnt']) > 0 ||
      (((raw['matlStationInfo'] as Map?)?['slotInfos'] as List?)?.isNotEmpty ?? false);

  bool get isCreator5 => pid == pidCreator5 || pid == pidCreator5Pro || (pid == null && name.contains('Creator 5'));
  bool get isCreator5Pro => pid == pidCreator5Pro || (pid == null && RegExp('Creator 5 Pro', caseSensitive: false).hasMatch(_s(raw['model']).isNotEmpty ? _s(raw['model']) : name));
  bool get isAD5X => pid == pidAD5X || (pid == null && (name == 'AD5X' || hasMatlStation) && !isCreator5);
  bool get isPro => pid == pid5MPro || (pid == null && name.contains('Pro') && !isAD5X && !isCreator5);

  List<Temp> get toolTemps {
    final t = raw['nozzleTemps'];
    final tt = raw['nozzleTargetTemps'];
    if (t is List && t.isNotEmpty) {
      return [for (var i = 0; i < t.length; i++) Temp(_d(t[i]), tt is List && i < tt.length ? _d(tt[i]) : 0)];
    }
    return [Temp(_d(raw['rightTemp']), _d(raw['rightTargetTemp']))];
  }

  int get nozzleCount => _i(raw['nozzleCnt']) > 0 ? _i(raw['nozzleCnt']) : toolTemps.length;
  Temp get bed => Temp(_d(raw['platTemp']), _d(raw['platTargetTemp']));
  Temp get chamber => Temp(_d(raw['chamberTemp']), _d(raw['chamberTargetTemp']));
  bool get hasChamberReading => raw.containsKey('chamberTemp');
  String get cameraStreamUrl => _s(raw['cameraStreamUrl']);
  bool get hasCamera => raw['camera'] == 1 || cameraStreamUrl.isNotEmpty;
  bool get lightsOn => _s(raw['lightStatus']) == 'open';
  bool get internalFanOn => _s(raw['internalFanStatus']) == 'open';
  bool get externalFanOn => _s(raw['externalFanStatus']) == 'open';
  bool get doorOpen => _s(raw['doorStatus']) == 'open';
  double get coolingFanSpeed => _d(raw['coolingFanSpeed']);
  double get chamberFanSpeed => _d(raw['chamberFanSpeed']);
  double get printProgress => _d(raw['printProgress']); // 0..1
  int get printLayer => _i(raw['printLayer']);
  int get targetPrintLayer => _i(raw['targetPrintLayer']);
  double get printDuration => _d(raw['printDuration']); // seconds
  double get estimatedTime => _d(raw['estimatedTime']); // seconds remaining
  String get printFileName => _s(raw['printFileName']);
  String get printFileThumbUrl => _s(raw['printFileThumbUrl']);
  int get printSpeedAdjust => _i(raw['printSpeedAdjust']) == 0 ? 100 : _i(raw['printSpeedAdjust']);
  double get zAxisCompensation => _d(raw['zAxisCompensation']);
  double get estimatedRightLen => _d(raw['estimatedRightLen']); // mm
  double get estimatedRightWeight => _d(raw['estimatedRightWeight']); // g
  double get cumulativeFilament => _d(raw['cumulativeFilament']);
  double get cumulativePrintTime => _d(raw['cumulativePrintTime']);
  double get remainingDiskSpace => _d(raw['remainingDiskSpace']);
  String get errorCode => _s(raw['errorCode']);
  String get ipAddr => _s(raw['ipAddr']);
  String get macAddr => _s(raw['macAddr']);
  String get nozzleModel => _s(raw['nozzleModel']);
  double get tvoc => _d(raw['tvoc']);
  String get filamentType => _s(raw['rightFilamentType']);

  Map<String, dynamic>? get matlStationInfo => raw['matlStationInfo'] is Map ? Map<String, dynamic>.from(raw['matlStationInfo']) : null;
  int get currentSlot => _i(matlStationInfo?['currentSlot']);
  List<SlotInfo> get slots {
    final infos = matlStationInfo?['slotInfos'];
    if (infos is! List) return const [];
    return [
      for (final s in infos)
        if (s is Map)
          SlotInfo(_i(s['slotId']), s['hasFilament'] == true, _s(s['materialName']), normalizeHex(_s(s['materialColor'])))
    ];
  }
}

String normalizeHex(String c) {
  var h = c.trim().replaceAll('#', '').toUpperCase();
  if (h.length == 8) h = h.substring(2); // AARRGGBB
  if (!RegExp(r'^[0-9A-F]{6}$').hasMatch(h)) return '';
  return '#$h';
}

class FileEntry {
  final String name;
  final int printingTime;
  final double totalFilamentWeight;
  final List<Map<String, dynamic>> toolDatas;
  FileEntry(this.name, {this.printingTime = 0, this.totalFilamentWeight = 0, this.toolDatas = const []});
}

class MaterialMapping {
  final int toolId; // 0..3
  final int slotId; // 1..4
  final String materialName;
  final String toolMaterialColor;
  final String slotMaterialColor;
  MaterialMapping(this.toolId, this.slotId, this.materialName, this.toolMaterialColor, this.slotMaterialColor);
  Map<String, dynamic> toJson() => {
        'toolId': toolId,
        'slotId': slotId,
        'materialName': materialName,
        'toolMaterialColor': toolMaterialColor,
        'slotMaterialColor': slotMaterialColor,
      };
}

/// Capabilities derived from /product (+ model overrides).
class Capabilities {
  bool led = false, filtration = false, chamber = false;
  Map<String, dynamic> toJson() => {'led': led, 'filtration': filtration, 'chamber': chamber};
}

// ---- Firmware colour palettes (msConfig_cmd needs an exact match) ----
const creator5Palette = [
  ['White', '#FFFFFF'], ['Yellow', '#FFF245'], ['Light Green', '#DEF578'], ['Green', '#21CC3D'],
  ['Dark Green', '#167A4B'], ['Teal', '#156682'], ['Cyan', '#24E4A0'], ['Light Blue', '#7BD9F0'],
  ['Blue', '#4CAAF8'], ['Dark Blue', '#2E54DD'], ['Purple', '#48358C'], ['Violet', '#A341F7'],
  ['Magenta', '#F435F6'], ['Pink', '#D5B4DE'], ['Coral', '#FA6173'], ['Red', '#F82D29'],
  ['Brown', '#805003'], ['Orange', '#F9903B'], ['Cream', '#FCEBD7'], ['Tan', '#D5C5A1'],
  ['Dark Brown', '#B17C38'], ['Gray', '#8C8C89'], ['Light Gray', '#BEBEBE'], ['Black', '#1B1B1B'],
];
const ad5xPalette = [
  ['White', '#FFFFFF'], ['Yellow', '#FEF043'], ['Light Green', '#DCF478'], ['Green', '#0ACC38'],
  ['Dark Green', '#067749'], ['Teal', '#0C6283'], ['Cyan', '#0DE2A0'], ['Light Blue', '#75D9F3'],
  ['Blue', '#45A8F9'], ['Dark Blue', '#2750E0'], ['Purple', '#46328E'], ['Violet', '#A03CF7'],
  ['Magenta', '#F330F9'], ['Pink', '#D4B0DC'], ['Coral', '#F95D73'], ['Red', '#F72224'],
  ['Brown', '#7C4B00'], ['Orange', '#F98D33'], ['Cream', '#FDEBD5'], ['Tan', '#D3C4A3'],
  ['Dark Brown', '#AF7836'], ['Gray', '#898989'], ['Light Gray', '#BCBCBC'], ['Black', '#161616'],
];
const materialNames = ['PLA', 'PLA-CF', 'PETG', 'PETG-CF', 'ABS', 'ASA', 'TPU', 'SILK', 'PLA+', 'PA', 'PA-CF', 'PC', 'HIPS', 'PVA'];

List<double> _lab(String hex) {
  final h = normalizeHex(hex);
  if (h.isEmpty) return [100, 0, 0];
  double lin(int c) {
    final v = c / 255.0;
    return v <= 0.04045 ? v / 12.92 : _pow((v + 0.055) / 1.055, 2.4);
  }
  final r = lin(int.parse(h.substring(1, 3), radix: 16));
  final g = lin(int.parse(h.substring(3, 5), radix: 16));
  final b = lin(int.parse(h.substring(5, 7), radix: 16));
  var x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  var y = (r * 0.2126729 + g * 0.7151522 + b * 0.072175);
  var z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  double f(double t) => t > 0.008856 ? _pow(t, 1 / 3) : 7.787 * t + 16 / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

double _pow(double a, double b) => a <= 0 ? 0 : math.pow(a, b).toDouble();

/// Snap an arbitrary colour to the nearest entry of a firmware palette (CIE76).
List<String> snapToPalette(String hex, {bool creator5 = true}) {
  final pal = creator5 ? creator5Palette : ad5xPalette;
  final l = _lab(hex);
  var best = pal.first;
  var bestD = double.infinity;
  for (final p in pal) {
    final m = _lab(p[1]);
    final d = (l[0] - m[0]) * (l[0] - m[0]) + (l[1] - m[1]) * (l[1] - m[1]) + (l[2] - m[2]) * (l[2] - m[2]);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}
