// UDP discovery of FlashForge printers (modern 276-byte and legacy 140-byte replies).
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

class DiscoveredPrinter {
  final String name, ip, serial, model;
  final int commandPort, eventPort, productId;
  DiscoveredPrinter(this.name, this.ip, this.serial, this.model, this.commandPort, this.eventPort, this.productId);
  Map<String, dynamic> toJson() =>
      {'name': name, 'ip': ip, 'serial': serial, 'model': model, 'commandPort': commandPort, 'eventPort': eventPort};
}

const _modernIds = {0x23: 'Adventurer 5M', 0x24: 'Adventurer 5M Pro', 0x26: 'AD5X', 0x28: 'Creator 5', 0x29: 'Creator 5 Pro'};

String _cstr(Uint8List b, int start, int end) {
  final s = b.sublist(start, end.clamp(start, b.length));
  final z = s.indexOf(0);
  return utf8.decode(z >= 0 ? s.sublist(0, z) : s, allowMalformed: true).trim();
}

DiscoveredPrinter? parseDiscovery(Uint8List b, String ip) {
  if (b.length < 140) return null;
  final bd = ByteData.sublistView(b);
  if (b.length >= 276) {
    final name = _cstr(b, 0, 0x84);
    final port = bd.getUint16(0x84);
    final pid = bd.getUint16(0x88);
    final ev = bd.getUint16(0x8e);
    final serial = _cstr(b, 0x92, 0x92 + 128);
    var model = _modernIds[pid] ?? '';
    if (model.isEmpty) {
      final u = name.toUpperCase();
      model = u.contains('CREATOR 5') ? 'Creator 5' : (u.contains('AD5X') ? 'AD5X' : (u.contains('5M') ? 'Adventurer 5M' : 'FlashForge'));
    }
    return DiscoveredPrinter(name, ip, serial, model, port, ev, pid);
  }
  final name = _cstr(b, 0, 0x80);
  final port = bd.getUint16(0x84);
  final pid = bd.getUint16(0x88);
  return DiscoveredPrinter(name, ip, '', 'Legacy FlashForge', port, 0, pid);
}

/// Broadcast/multicast discovery. Returns unique printers found within [timeout].
Future<List<DiscoveredPrinter>> discoverPrinters({Duration timeout = const Duration(seconds: 6)}) async {
  final found = <String, DiscoveredPrinter>{};
  final sock = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0, reuseAddress: true);
  sock.broadcastEnabled = true;
  final sub = sock.listen((ev) {
    if (ev != RawSocketEvent.read) return;
    final dg = sock.receive();
    if (dg == null) return;
    final p = parseDiscovery(dg.data, dg.address.address);
    if (p != null) {
      final k = '${p.ip}:${p.commandPort}';
      if (!found.containsKey(k) || p.serial.isNotEmpty) found[k] = p;
    }
  });
  final targets = <String>{'255.255.255.255'};
  try {
    for (final ni in await NetworkInterface.list(type: InternetAddressType.IPv4)) {
      for (final a in ni.addresses) {
        final parts = a.address.split('.');
        if (parts.length == 4 && !a.isLoopback) targets.add('${parts[0]}.${parts[1]}.${parts[2]}.255');
      }
    }
  } catch (_) {}
  void send() {
    final empty = Uint8List(0);
    for (final t in targets) {
      for (final port in [48899, 8899, 19000]) {
        try {
          sock.send(empty, InternetAddress(t), port);
        } catch (_) {}
      }
    }
    for (final port in [8899, 19000]) {
      try {
        sock.send(empty, InternetAddress('225.0.0.9'), port);
      } catch (_) {}
    }
  }

  send();
  final t = Timer.periodic(const Duration(seconds: 2), (_) => send());
  await Future.delayed(timeout);
  t.cancel();
  await sub.cancel();
  sock.close();
  return found.values.toList();
}
