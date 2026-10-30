// Settings that only exist on the Pi build (AI failure detection, setup page password).
// Stored next to the shared ffbridge.json in <dataDir>/pi.json so the TV app's config
// format stays untouched.
import 'dart:convert';
import 'dart:io';

class AiSettings {
  /// Master switch for failure detection.
  bool enabled;

  /// 'notify' = warn only, 'pause' = warn and pause the print when the failure is clear.
  String action;

  /// 'low' | 'medium' | 'high' (maps to Obico's "detective sensitivity" multiplier).
  String sensitivity;

  /// Seconds between checks while printing. Obico's thresholds are tuned for 10 s.
  int intervalSeconds;

  /// Printer ids that have detection switched off.
  Set<String> disabledPrinters;

  AiSettings({
    this.enabled = true,
    this.action = 'notify',
    this.sensitivity = 'medium',
    this.intervalSeconds = 10,
    Set<String>? disabledPrinters,
  }) : disabledPrinters = disabledPrinters ?? {};

  double get sensitivityFactor => switch (sensitivity) { 'low' => 0.8, 'high' => 1.2, _ => 1.0 };

  bool enabledFor(String printerId) => enabled && !disabledPrinters.contains(printerId);

  factory AiSettings.fromJson(Map<String, dynamic> j) => AiSettings(
        enabled: j['enabled'] ?? true,
        action: (j['action'] == 'pause') ? 'pause' : 'notify',
        sensitivity: const ['low', 'medium', 'high'].contains(j['sensitivity']) ? j['sensitivity'] : 'medium',
        intervalSeconds: ((j['intervalSeconds'] as num?)?.toInt() ?? 10).clamp(5, 120),
        disabledPrinters: {for (final e in (j['disabledPrinters'] as List? ?? [])) e.toString()},
      );

  Map<String, dynamic> toJson() => {
        'enabled': enabled,
        'action': action,
        'sensitivity': sensitivity,
        'intervalSeconds': intervalSeconds,
        'disabledPrinters': disabledPrinters.toList(),
      };
}

class PiConfig {
  final File _file;
  AiSettings ai = AiSettings();

  /// Optional password for the setup page (empty = open on the local network).
  String setupPassword = '';

  /// Show the slicer (Prepare / Paint / Preview) in the web page.
  bool slicerEnabled = true;

  PiConfig(String dataDir) : _file = File('$dataDir/pi.json') {
    load();
  }

  void load() {
    try {
      final j = jsonDecode(_file.readAsStringSync()) as Map<String, dynamic>;
      ai = AiSettings.fromJson(Map<String, dynamic>.from(j['ai'] as Map? ?? {}));
      setupPassword = j['setupPassword'] ?? '';
      slicerEnabled = j['slicerEnabled'] ?? true;
    } catch (_) {}
  }

  void save() {
    _file.parent.createSync(recursive: true);
    final tmp = File('${_file.path}.tmp');
    tmp.writeAsStringSync(const JsonEncoder.withIndent('  ').convert({'ai': ai.toJson(), 'setupPassword': setupPassword, 'slicerEnabled': slicerEnabled}));
    tmp.renameSync(_file.path);
  }
}
