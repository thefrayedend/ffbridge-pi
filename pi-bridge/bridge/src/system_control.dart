// Network / power control for the setup page.
//
// The bridge runs as an unprivileged user. Everything that needs root goes through one
// small, auditable helper script (image/rootfs/usr/local/sbin/ffbridge-helper) that the
// image allows via sudo. On a development PC the helper does not exist and these calls
// report "not available".
import 'dart:async';
import 'dart:convert';
import 'dart:io';

class SystemControl {
  final String helper;
  SystemControl({this.helper = '/usr/local/sbin/ffbridge-helper'});

  bool get available => Platform.isLinux && File(helper).existsSync();

  Future<Map<String, dynamic>> _run(List<String> args, {String? stdinText, Duration timeout = const Duration(seconds: 45)}) async {
    if (!available) return {'ok': false, 'message': 'Not available on this computer (only on the bridge board).'};
    final p = await Process.start('sudo', ['-n', helper, ...args]);
    if (stdinText != null) p.stdin.write(stdinText);
    await p.stdin.close();
    final out = p.stdout.transform(utf8.decoder).join();
    final err = p.stderr.transform(utf8.decoder).join();
    final code = await p.exitCode.timeout(timeout, onTimeout: () {
      p.kill();
      return -1;
    });
    final o = (await out).trim();
    try {
      final j = jsonDecode(o);
      if (j is Map<String, dynamic>) return j;
      return {'ok': code == 0, 'data': j};
    } catch (_) {
      return {'ok': code == 0, 'message': o.isNotEmpty ? o : (await err).trim()};
    }
  }

  Future<Map<String, dynamic>> networkStatus() => _run(['net-status']);
  Future<Map<String, dynamic>> wifiScan() => _run(['wifi-scan']);
  Future<Map<String, dynamic>> wifiConnect(String ssid, String password) =>
      _run(['wifi-connect', ssid], stdinText: password, timeout: const Duration(seconds: 90));
  Future<Map<String, dynamic>> wifiForget() => _run(['wifi-forget']);
  Future<Map<String, dynamic>> setHostname(String name) => _run(['set-hostname', name]);
  Future<Map<String, dynamic>> reboot() => _run(['reboot']);
  Future<Map<String, dynamic>> shutdown() => _run(['shutdown']);
  Future<Map<String, dynamic>> restartAi() => _run(['restart-ai']);
  // While the slicer runs the AI service is stopped (it holds up to 1.5 GB and busy CPU cores).
  Future<Map<String, dynamic>> aiPause() => _run(['ai-pause']);
  Future<Map<String, dynamic>> aiResume() => _run(['ai-resume']);
  Future<Map<String, dynamic>> updateStart(String baseUrl) => _run(['update-start', baseUrl]);
  Future<Map<String, dynamic>> systemInfo() => _run(['system-info']);
  // Printer network (router mode): the board's Wi-Fi becomes a private network for the printers.
  Future<Map<String, dynamic>> printerNetStatus() => _run(['printernet-status']);
  Future<Map<String, dynamic>> printerNetEnable(String ssid, String password) =>
      _run(['printernet-enable', ssid], stdinText: password, timeout: const Duration(seconds: 60));
  Future<Map<String, dynamic>> printerNetDisable() => _run(['printernet-disable'], timeout: const Duration(seconds: 90));
  Future<Map<String, dynamic>> printerNetInternet(int minutes) => _run(['printernet-internet', '$minutes']);

  /// Local IPv4 addresses (ethernet / wifi first).
  static Future<List<String>> localIps() async {
    final out = <String>[];
    try {
      final list = await NetworkInterface.list(type: InternetAddressType.IPv4);
      list.sort((a, b) => _rank(a.name).compareTo(_rank(b.name)));
      for (final ni in list) {
        for (final a in ni.addresses) {
          if (!a.isLoopback) out.add(a.address);
        }
      }
    } catch (_) {}
    return out;
  }

  static int _rank(String n) => n.startsWith('eth') || n.startsWith('end') ? 0 : (n.startsWith('wl') ? 1 : 2);

  static String hostname() {
    try {
      return Platform.localHostname.split('.').first;
    } catch (_) {
      return 'ffbridge';
    }
  }
}
