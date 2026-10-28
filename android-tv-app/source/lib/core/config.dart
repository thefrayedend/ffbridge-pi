// Persistent app configuration (printers + integrations).
import 'dart:convert';
import 'dart:io';

class PrinterConfig {
  String id;
  String name;
  String ip;
  String serial;
  String checkCode;
  int port; // Moonraker/Mainsail port served by this app
  bool levelBeforePrint;
  String cameraUrl; // optional override (MJPEG); empty = auto
  bool enabled;
  String model;

  PrinterConfig({
    required this.id,
    required this.name,
    required this.ip,
    required this.serial,
    required this.checkCode,
    this.port = 7125,
    this.levelBeforePrint = false,
    this.cameraUrl = '',
    this.enabled = true,
    this.model = '',
  });

  factory PrinterConfig.fromJson(Map<String, dynamic> j) => PrinterConfig(
        id: j['id'] ?? DateTime.now().millisecondsSinceEpoch.toString(),
        name: j['name'] ?? 'FlashForge',
        ip: j['ip'] ?? '',
        serial: j['serial'] ?? '',
        checkCode: j['checkCode'] ?? '',
        port: j['port'] ?? 7125,
        levelBeforePrint: j['levelBeforePrint'] ?? false,
        cameraUrl: j['cameraUrl'] ?? '',
        enabled: j['enabled'] ?? true,
        model: j['model'] ?? '',
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'ip': ip,
        'serial': serial,
        'checkCode': checkCode,
        'port': port,
        'levelBeforePrint': levelBeforePrint,
        'cameraUrl': cameraUrl,
        'enabled': enabled,
        'model': model,
      };
}

class AppConfig {
  final File _file;
  List<PrinterConfig> printers = [];
  String spoolmanUrl = '';
  String discordWebhook = '';
  int discordIntervalMinutes = 0; // 0 = only events
  bool discordSnapshot = true;
  bool notifyOnComplete = true, notifyOnError = true, notifyOnPause = true, notifyOnStart = true;

  /// Multi-colour jobs: 'auto' = start right away when every filament matches a loaded spool,
  /// otherwise ask in Mainsail; 'always' = always ask before starting.
  String mappingMode = 'auto';

  AppConfig(String dataDir) : _file = File('$dataDir/ffbridge.json') {
    load();
  }

  void load() {
    try {
      final j = jsonDecode(_file.readAsStringSync()) as Map<String, dynamic>;
      printers = [for (final p in (j['printers'] as List? ?? [])) PrinterConfig.fromJson(Map<String, dynamic>.from(p))];
      spoolmanUrl = j['spoolmanUrl'] ?? '';
      discordWebhook = j['discordWebhook'] ?? '';
      discordIntervalMinutes = j['discordIntervalMinutes'] ?? 0;
      discordSnapshot = j['discordSnapshot'] ?? true;
      notifyOnComplete = j['notifyOnComplete'] ?? true;
      notifyOnError = j['notifyOnError'] ?? true;
      notifyOnPause = j['notifyOnPause'] ?? true;
      notifyOnStart = j['notifyOnStart'] ?? true;
      mappingMode = j['mappingMode'] == 'always' ? 'always' : 'auto';
    } catch (_) {}
  }

  Map<String, dynamic> toJson() => {
        'printers': [for (final p in printers) p.toJson()],
        'spoolmanUrl': spoolmanUrl,
        'discordWebhook': discordWebhook,
        'discordIntervalMinutes': discordIntervalMinutes,
        'discordSnapshot': discordSnapshot,
        'notifyOnComplete': notifyOnComplete,
        'notifyOnError': notifyOnError,
        'notifyOnPause': notifyOnPause,
        'notifyOnStart': notifyOnStart,
        'mappingMode': mappingMode,
      };

  void save() {
    _file.parent.createSync(recursive: true);
    _file.writeAsStringSync(const JsonEncoder.withIndent('  ').convert(toJson()));
  }

  int nextFreePort() {
    var p = 7125;
    while (printers.any((e) => e.port == p)) {
      p++;
    }
    return p;
  }
}
