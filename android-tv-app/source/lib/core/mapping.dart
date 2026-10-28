// Smart filament -> material-station slot mapping for multi-colour jobs (AD5X / Creator 5).
//
// The slicer file lists the filaments it was sliced with (type + colour). The printer reports
// what is loaded in each slot. We pick, for every slicer filament, the loaded slot with the
// same material and the closest colour (CIEDE2000 colour difference, the standard measure of
// how different two colours look to a person). When everything matches well the print can
// start straight away; otherwise the user is asked to confirm in Mainsail.
import 'dart:math' as math;

import 'ff/models.dart';

class SlicerFilament {
  final int index; // 0-based tool index in the file
  final String type;
  final String color; // #RRGGBB
  SlicerFilament(this.index, this.type, this.color);
}

class LoadedSlot {
  final int slotId; // 1..4
  final String material;
  final String color; // #RRGGBB
  LoadedSlot(this.slotId, this.material, this.color);
}

/// One line of a mapping: slicer filament -> slot, with how good the match is.
class MapLine {
  final SlicerFilament filament;
  LoadedSlot slot;
  MapLine(this.filament, this.slot);

  double get colorDiff => deltaE2000(filament.color, slot.color);
  int get materialScore => materialMatch(filament.type, slot.material); // 0 exact, 1 same family, 2 different
  bool get good => materialScore <= 1 && colorDiff <= MappingPlan.goodColorDiff;

  String get verdict {
    if (materialScore == 2) return 'different material!';
    if (colorDiff <= 8) return 'match';
    if (colorDiff <= MappingPlan.goodColorDiff) return 'close colour';
    return 'different colour';
  }
}

class MappingPlan {
  /// Largest colour difference still treated as "the same colour" (spool colours entered on the
  /// printer and in the slicer are rarely identical hex values).
  static const goodColorDiff = 20.0;

  final String file;
  final List<MapLine> lines;
  final List<LoadedSlot> slots;
  MappingPlan(this.file, this.lines, this.slots);

  bool get confident => lines.every((l) => l.good);

  List<MaterialMapping> toMappings() => [
        for (final l in lines)
          MaterialMapping(
            l.filament.index.clamp(0, 3),
            l.slot.slotId,
            l.filament.type.isEmpty ? (l.slot.material.isEmpty ? 'PLA' : l.slot.material) : l.filament.type,
            l.filament.color,
            l.slot.color,
          )
      ];

  void setSlot(int filamentIndex, int slotId) {
    final line = lines.firstWhere((l) => l.filament.index == filamentIndex, orElse: () => throw ArgumentError('Unknown filament ${filamentIndex + 1}'));
    line.slot = slots.firstWhere((s) => s.slotId == slotId, orElse: () => throw ArgumentError('Slot $slotId has no filament loaded'));
  }
}

/// Builds the best mapping, or null when the job / printer has nothing to map.
MappingPlan? planMapping(String file, List<SlicerFilament> fils, List<SlotInfo> printerSlots) {
  final slots = [
    for (final s in printerSlots)
      if (s.hasFilament) LoadedSlot(s.slotId, s.materialName, normalizeColor(s.materialColor).isEmpty ? '#FFFFFF' : normalizeColor(s.materialColor))
  ];
  if (fils.isEmpty || slots.isEmpty) return null;
  final n = fils.length;
  // Try every assignment (at most 4 filaments x 4 slots = 256): lowest total cost wins.
  // Cost = colour difference + big penalty for a different material + small one for re-using a slot.
  List<int>? best;
  var bestCost = double.infinity;
  final pick = List<int>.filled(n, 0);
  final cost = [
    for (final f in fils)
      [for (final s in slots) deltaE2000(f.color, s.color) + const [0, 6, 1000][materialMatch(f.type, s.material)]]
  ];
  void search(int i, double acc) {
    if (acc >= bestCost) return;
    if (i == n) {
      final used = <int>{};
      var reuse = 0.0;
      for (final p in pick) {
        if (!used.add(p)) reuse += 25;
      }
      if (acc + reuse < bestCost) {
        bestCost = acc + reuse;
        best = List.of(pick);
      }
      return;
    }
    for (var j = 0; j < slots.length; j++) {
      pick[i] = j;
      search(i + 1, acc + cost[i][j]);
    }
  }

  search(0, 0);
  return MappingPlan(file, [for (var i = 0; i < n; i++) MapLine(fils[i], slots[best![i]])], slots);
}

// ------------------------------------------------------------------ materials
String materialFamily(String m) {
  final u = m.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');
  for (final f in const ['PETG', 'PLA', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'PVA', 'HIPS', 'PET']) {
    if (u.startsWith(f)) return f;
  }
  return u;
}

/// 0 = same material, 1 = same family (e.g. PLA vs PLA Silk), 2 = different.
int materialMatch(String a, String b) {
  final na = a.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');
  final nb = b.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');
  if (na.isEmpty || nb.isEmpty || na == nb) return 0;
  return materialFamily(a) == materialFamily(b) ? 1 : 2;
}

// ------------------------------------------------------------------ colours
String normalizeColor(String c) {
  var h = c.trim().replaceAll('#', '');
  if (h.length == 3) h = h.split('').map((x) => '$x$x').join();
  return normalizeHex(h); // same rules the rest of the bridge uses (8 digits = AARRGGBB)
}

List<double> _lab(String hex) {
  final h = normalizeColor(hex);
  final v = h.isEmpty ? 0xFFFFFF : int.parse(h.substring(1), radix: 16);
  double lin(int c) {
    final x = c / 255.0;
    return x <= 0.04045 ? x / 12.92 : math.pow((x + 0.055) / 1.055, 2.4).toDouble();
  }

  final r = lin((v >> 16) & 255), g = lin((v >> 8) & 255), b = lin(v & 255);
  final x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  final y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1.0;
  final z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  double f(double t) => t > 0.008856 ? math.pow(t, 1 / 3).toDouble() : 7.787 * t + 16 / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/// CIEDE2000 colour difference: ~0 identical, <3 hard to tell apart, >20 clearly different.
double deltaE2000(String c1, String c2) {
  final a = _lab(c1), b = _lab(c2);
  const kL = 1.0, kC = 1.0, kH = 1.0;
  final l1 = a[0], a1 = a[1], b1 = a[2], l2 = b[0], a2 = b[1], b2 = b[2];
  final c1x = math.sqrt(a1 * a1 + b1 * b1), c2x = math.sqrt(a2 * a2 + b2 * b2);
  final cBar = (c1x + c2x) / 2;
  final g = 0.5 * (1 - math.sqrt(math.pow(cBar, 7) / (math.pow(cBar, 7) + math.pow(25, 7))));
  final a1p = (1 + g) * a1, a2p = (1 + g) * a2;
  final c1p = math.sqrt(a1p * a1p + b1 * b1), c2p = math.sqrt(a2p * a2p + b2 * b2);
  double hp(double bb, double ap) {
    if (bb == 0 && ap == 0) return 0;
    final h = math.atan2(bb, ap) * 180 / math.pi;
    return h < 0 ? h + 360 : h;
  }

  final h1p = hp(b1, a1p), h2p = hp(b2, a2p);
  final dLp = l2 - l1, dCp = c2p - c1p;
  var dhp = 0.0;
  if (c1p * c2p != 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    if (dhp < -180) dhp += 360;
  }
  final dHp = 2 * math.sqrt(c1p * c2p) * math.sin(dhp * math.pi / 360);
  final lBarp = (l1 + l2) / 2, cBarp = (c1p + c2p) / 2;
  var hBarp = h1p + h2p;
  if (c1p * c2p != 0) {
    if ((h1p - h2p).abs() > 180) hBarp += h1p + h2p < 360 ? 360 : -360;
    hBarp /= 2;
  }
  final t = 1 -
      0.17 * math.cos((hBarp - 30) * math.pi / 180) +
      0.24 * math.cos(2 * hBarp * math.pi / 180) +
      0.32 * math.cos((3 * hBarp + 6) * math.pi / 180) -
      0.20 * math.cos((4 * hBarp - 63) * math.pi / 180);
  final dTheta = 30 * math.exp(-math.pow((hBarp - 275) / 25, 2));
  final rc = 2 * math.sqrt(math.pow(cBarp, 7) / (math.pow(cBarp, 7) + math.pow(25, 7)));
  final sl = 1 + 0.015 * math.pow(lBarp - 50, 2) / math.sqrt(20 + math.pow(lBarp - 50, 2));
  final sc = 1 + 0.045 * cBarp, sh = 1 + 0.015 * cBarp * t;
  final rt = -math.sin(2 * dTheta * math.pi / 180) * rc;
  return math.sqrt(math.pow(dLp / (kL * sl), 2) +
      math.pow(dCp / (kC * sc), 2) +
      math.pow(dHp / (kH * sh), 2) +
      rt * (dCp / (kC * sc)) * (dHp / (kH * sh)));
}

/// Plain colour name for messages ("red", "dark blue", ...).
String colorName(String hex) {
  const names = {
    'black': '#000000', 'white': '#FFFFFF', 'grey': '#808080', 'light grey': '#C8C8C8', 'dark grey': '#404040',
    'red': '#E02020', 'dark red': '#8B0000', 'orange': '#FF8C00', 'yellow': '#FFE000', 'gold': '#D4AF37',
    'green': '#20A040', 'light green': '#90EE90', 'dark green': '#006400', 'teal': '#008080', 'cyan': '#00C8E0',
    'blue': '#2060E0', 'light blue': '#80B0FF', 'navy': '#000080', 'purple': '#8030C0', 'pink': '#FF80C0',
    'magenta': '#E000E0', 'brown': '#8B5A2B', 'beige': '#E8D8B0', 'silver': '#B0B0B8',
  };
  var best = 'colour', bestD = double.infinity;
  names.forEach((name, h) {
    final d = deltaE2000(hex, h);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  });
  return best;
}
