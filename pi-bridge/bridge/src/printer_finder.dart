// Follows printers to a new network address.
//
// Printers are saved by IP address. When a printer gets a new address (the router handed out a
// different one, or the printer moved onto the board's printer network in router mode), the
// bridge would show it offline forever. This looks for printers that have been offline for a
// minute, searches the network, and when it finds the same serial number at a new address it
// updates the saved address by itself.
import 'dart:async';

import 'core.dart';

/// Pure decision, separated for testing: printer id -> new IP for offline printers whose serial
/// number was found at a different address.
Map<String, String> movedPrinters(List<PrinterConfig> printers, Set<String> offlineIds, List<DiscoveredPrinter> found) {
  final bySerial = <String, String>{};
  for (final f in found) {
    if (f.serial.isNotEmpty) bySerial[f.serial.toUpperCase()] = f.ip;
  }
  final out = <String, String>{};
  for (final p in printers) {
    if (!p.enabled || p.serial.isEmpty || !offlineIds.contains(p.id)) continue;
    final ip = bySerial[p.serial.toUpperCase()];
    if (ip != null && ip != p.ip) out[p.id] = ip;
  }
  return out;
}

class PrinterFinder {
  final BridgeHost host;
  final Future<List<DiscoveredPrinter>> Function() discover;
  PrinterFinder(this.host, {Future<List<DiscoveredPrinter>> Function()? discover})
      : discover = discover ?? (() => discoverPrinters(timeout: const Duration(seconds: 5)));

  final Map<String, DateTime> _offlineSince = {};
  Timer? _timer;
  bool _busy = false;

  void start({Duration every = const Duration(seconds: 45)}) {
    _timer = Timer.periodic(every, (_) => check().ignore());
  }

  void stop() => _timer?.cancel();

  Future<void> check({Duration offlineFor = const Duration(minutes: 1)}) async {
    if (_busy) return;
    _busy = true;
    try {
      final now = DateTime.now();
      final waiting = <String>{};
      for (final p in host.config.printers) {
        final online = host.instances[p.id]?.bridge.online ?? false;
        if (online || !p.enabled) {
          _offlineSince.remove(p.id);
          continue;
        }
        final since = _offlineSince.putIfAbsent(p.id, () => now);
        if (now.difference(since) >= offlineFor) waiting.add(p.id);
      }
      if (waiting.isEmpty) return;
      final moved = movedPrinters(host.config.printers, waiting, await discover());
      for (final e in moved.entries) {
        final p = host.config.printers.firstWhere((x) => x.id == e.key);
        host.log.info('${p.name}: found at a new address ${e.value} (was ${p.ip}), updating');
        p.ip = e.value;
        _offlineSince.remove(p.id);
        await host.addOrUpdate(p);
      }
    } catch (e) {
      host.log.warn('Printer address check failed: $e');
    } finally {
      _busy = false;
    }
  }
}
