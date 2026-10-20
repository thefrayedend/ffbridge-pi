// BridgeHost: owns the configuration and one PrinterBridge + MoonrakerServer per printer.
import 'dart:async';
import 'dart:io';

import 'bridge.dart';
import 'config.dart';
import 'log.dart';
import 'moonraker/server.dart';

class BridgeInstance {
  final PrinterBridge bridge;
  final MoonrakerServer server;
  String? error;
  BridgeInstance(this.bridge, this.server);
}

class BridgeHost {
  final String dataRoot;
  final String webRoot;
  late final AppConfig config = AppConfig(dataRoot);
  late final Log log = Log('$dataRoot/ffbridge.log');
  final Map<String, BridgeInstance> instances = {};
  final _changes = StreamController<void>.broadcast();
  Stream<void> get changes => _changes.stream;

  BridgeHost(this.dataRoot, this.webRoot) {
    Directory(dataRoot).createSync(recursive: true);
  }

  Future<void> startAll() async {
    for (final p in config.printers) {
      if (p.enabled) await startPrinter(p);
    }
    _changes.add(null);
  }

  Future<void> startPrinter(PrinterConfig p) async {
    await stopPrinter(p.id);
    final dir = '$dataRoot/printers/${p.id}';
    Directory(dir).createSync(recursive: true);
    final bridge = PrinterBridge(p, config, dir, log);
    final server = MoonrakerServer(bridge, webRoot, p.port);
    final inst = BridgeInstance(bridge, server);
    instances[p.id] = inst;
    try {
      await server.start();
    } catch (e) {
      inst.error = 'Cannot listen on port ${p.port}: $e';
      log.error(inst.error!);
    }
    bridge.changes.listen((_) => _changes.add(null));
    await bridge.start();
    _changes.add(null);
  }

  Future<void> stopPrinter(String id) async {
    final inst = instances.remove(id);
    if (inst == null) return;
    await inst.server.stop();
    await inst.bridge.dispose();
    _changes.add(null);
  }

  Future<void> addOrUpdate(PrinterConfig p) async {
    final i = config.printers.indexWhere((e) => e.id == p.id);
    if (i >= 0) {
      config.printers[i] = p;
    } else {
      config.printers.add(p);
    }
    config.save();
    if (p.enabled) {
      await startPrinter(p);
    } else {
      await stopPrinter(p.id);
    }
  }

  Future<void> remove(String id) async {
    await stopPrinter(id);
    config.printers.removeWhere((e) => e.id == id);
    config.save();
    _changes.add(null);
  }

  /// Re-applies integration settings (Spoolman / Discord) to running bridges.
  void applyIntegrations() {
    config.save();
    for (final i in instances.values) {
      i.bridge.spoolman.baseUrl = config.spoolmanUrl;
      i.bridge.discord.webhookUrl = config.discordWebhook;
    }
  }

  Future<void> stopAll() async {
    for (final id in instances.keys.toList()) {
      await stopPrinter(id);
    }
  }
}
