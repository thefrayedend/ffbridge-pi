// One-click updates: looks for a newer bridge on GitHub and starts the root helper to install it.
// GitHub's build publishes ffbridge-update.json + ffbridge-update.tar.gz with the SD card image.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'core.dart';
import 'setup_server.dart' show piBridgeVersion, updateRepo;
import 'system_control.dart';

class Updater {
  final Log log;
  final SystemControl sys;
  final String installRoot; // "/" on the board
  Updater(this.log, this.sys, {this.installRoot = '/'});

  Map<String, dynamic>? latest;
  DateTime? checkedAt;
  String checkError = '';
  Timer? _timer;

  String get baseUrl => 'https://github.com/$updateRepo/releases/download/latest-image';
  bool get configured => updateRepo.isNotEmpty;

  /// "1.0.12" > "1.0.9"; anything vs "dev" -> false (local builds never update themselves).
  static bool isNewer(String candidate, String current) {
    if (current == 'dev' || candidate.isEmpty) return false;
    List<int> parts(String v) => v.split('.').map((e) => int.tryParse(e.replaceAll(RegExp(r'[^0-9]'), '')) ?? 0).toList();
    final a = parts(candidate), b = parts(current);
    for (var i = 0; i < (a.length > b.length ? a.length : b.length); i++) {
      final x = i < a.length ? a[i] : 0, y = i < b.length ? b[i] : 0;
      if (x != y) return x > y;
    }
    return false;
  }

  String get _imageHash {
    try {
      return File('$installRoot/opt/ffbridge/IMAGE_HASH'.replaceAll('//', '/')).readAsStringSync().trim();
    } catch (_) {
      return '';
    }
  }

  bool get available => latest != null && isNewer('${latest!['version']}', piBridgeVersion);
  bool get imageRequired {
    final want = '${latest?['imageHash'] ?? ''}', have = _imageHash;
    return available && want.isNotEmpty && have.isNotEmpty && want != have;
  }

  Map<String, dynamic>? get installStatus {
    try {
      return jsonDecode(File('/var/lib/ffbridge-sys/update/status.json').readAsStringSync()) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  void start() {
    if (!configured) return;
    Timer(const Duration(minutes: 2), () => check().ignore());
    _timer = Timer.periodic(const Duration(hours: 12), (_) => check().ignore());
  }

  void stop() => _timer?.cancel();

  Future<void> check() async {
    if (!configured) return;
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 15);
    try {
      final req = await client.getUrl(Uri.parse('$baseUrl/ffbridge-update.json'));
      req.headers.set('User-Agent', 'ffbridge/$piBridgeVersion');
      final res = await req.close().timeout(const Duration(seconds: 30));
      if (res.statusCode == 404) {
        checkError = 'No update package published yet.';
        await res.drain<void>();
        return;
      }
      if (res.statusCode != 200) throw HttpException('GitHub answered ${res.statusCode}');
      latest = jsonDecode(await utf8.decodeStream(res)) as Map<String, dynamic>;
      checkError = '';
      if (available) log.info('Update available: ${latest!['version']} (running $piBridgeVersion)');
    } catch (e) {
      checkError = 'Could not reach GitHub to check for updates ($e).';
    } finally {
      checkedAt = DateTime.now();
      client.close(force: true);
    }
  }

  Future<Map<String, dynamic>> install() async {
    if (!configured) return {'ok': false, 'message': 'Updates are not set up in this build.'};
    if (!available) return {'ok': false, 'message': 'You already have the newest version.'};
    if (imageRequired) {
      return {'ok': false, 'message': 'This update needs a new SD card image. Download your settings backup first, then flash the new image.'};
    }
    log.info('Installing update ${latest!['version']}');
    return sys.updateStart(baseUrl);
  }

  Map<String, dynamic> toJson() => {
        'current': piBridgeVersion,
        'configured': configured,
        'latest': latest?['version'],
        'notes': latest?['notes'] ?? '',
        'built': latest?['built'],
        'available': available,
        'imageRequired': imageRequired,
        'imageUrl': configured ? 'https://github.com/$updateRepo/releases/tag/latest-image' : '',
        'checkedAt': checkedAt?.toIso8601String(),
        'checkError': checkError,
        'install': installStatus,
      };
}
