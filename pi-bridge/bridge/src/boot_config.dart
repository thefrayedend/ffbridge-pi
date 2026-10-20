// Reads the user-editable ffbridge-config.txt on the SD card's "FFBRIDGE" drive.
//
// Wi-Fi / hostname / SSH lines are applied by the root helper at boot
// (image/rootfs/usr/local/sbin/ffbridge-apply-config). This file handles the optional
// printer lines so a printer can be pre-configured without opening the setup page, and
// writes MY-BRIDGE-ADDRESS.txt back to the same drive so the user can find the board.
import 'dart:convert';
import 'dart:io';

import 'core.dart';

Map<String, String> parseConfigText(String text) {
  final out = <String, String>{};
  for (var line in const LineSplitter().convert(text)) {
    line = line.trim();
    if (line.isEmpty || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue;
    final i = line.indexOf('=');
    if (i <= 0) continue;
    var v = line.substring(i + 1).trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.substring(1, v.length - 1);
    }
    out[line.substring(0, i).trim().toLowerCase()] = v;
  }
  return out;
}

class BootConfig {
  final String partitionDir;
  final BridgeHost host;
  BootConfig(this.partitionDir, this.host);

  File get configFile => File('$partitionDir/ffbridge-config.txt');
  File get _appliedMarker => File('${host.dataRoot}/boot-config-printer.applied');

  /// Adds/updates the printer described by printer_ip / printer_code (/ printer_serial / printer_name).
  Future<void> applyPrinter() async {
    if (!configFile.existsSync()) return;
    final c = parseConfigText(configFile.readAsStringSync());
    final ip = c['printer_ip'] ?? '';
    final code = c['printer_code'] ?? c['printer_pairing_code'] ?? '';
    if (ip.isEmpty || code.isEmpty) return;
    final fingerprint = [ip, code, c['printer_serial'] ?? '', c['printer_name'] ?? ''].join('|');
    if (_appliedMarker.existsSync() && _appliedMarker.readAsStringSync() == fingerprint) return;
    var serial = c['printer_serial'] ?? '';
    if (serial.isEmpty) {
      for (var attempt = 0; attempt < 6 && serial.isEmpty; attempt++) {
        try {
          final found = await discoverPrinters(timeout: const Duration(seconds: 5));
          serial = found.where((f) => f.ip == ip && f.serial.isNotEmpty).firstOrNull?.serial ?? '';
        } catch (_) {}
        if (serial.isEmpty) await Future.delayed(const Duration(seconds: 10)); // network may still be coming up
      }
    }
    if (serial.isEmpty) {
      host.log.warn('ffbridge-config.txt: printer $ip not found on the network; add it from the setup page instead.');
      return;
    }
    final existing = host.config.printers.where((p) => p.ip == ip).firstOrNull;
    final p = existing ??
        PrinterConfig(id: 'p${DateTime.now().millisecondsSinceEpoch}', name: 'FlashForge', ip: ip, serial: serial, checkCode: code, port: host.config.nextFreePort());
    p
      ..serial = serial
      ..checkCode = code
      ..name = (c['printer_name'] ?? '').isNotEmpty ? c['printer_name']! : p.name;
    await host.addOrUpdate(p);
    _appliedMarker.writeAsStringSync(fingerprint);
    host.log.info('ffbridge-config.txt: printer ${p.name} at $ip configured.');
  }

  String _lastWritten = '';

  /// Writes the board's current addresses to MY-BRIDGE-ADDRESS.txt on the SD card.
  void writeAddressFile(String hostname, List<String> ips) {
    if (!Directory(partitionDir).existsSync()) return;
    final ports = [for (final p in host.config.printers) p.port];
    final b = StringBuffer()
      ..writeln('FlashForge Pi Bridge - how to reach this board')
      ..writeln('================================================')
      ..writeln()
      ..writeln('Setup page:   http://$hostname.local')
      ..writeln();
    for (final ip in ips) {
      b.writeln('           or http://$ip');
    }
    b.writeln();
    if (ports.isNotEmpty) {
      b.writeln('Mainsail / OrcaSlicer ("Octo/Klipper" host):');
      for (final p in host.config.printers) {
        b.writeln('  ${p.name}: ${ips.isEmpty ? '$hostname.local' : ips.first}:${p.port}');
      }
    } else {
      b.writeln('No printer added yet - open the setup page to add one.');
    }
    b
      ..writeln()
      ..writeln('(This file is rewritten by the bridge whenever its address changes.)');
    final text = b.toString().replaceAll('\n', '\r\n'); // Notepad-friendly
    if (text == _lastWritten) return;
    try {
      File('$partitionDir/MY-BRIDGE-ADDRESS.txt').writeAsStringSync(text, flush: true);
      _lastWritten = text;
    } catch (_) {}
  }
}
