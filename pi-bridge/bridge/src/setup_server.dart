// Setup page web server (port 80 on the board): static files from web/ + a small JSON API.
// This is the browser version of the Android TV app's Printers / Settings / Logs screens,
// plus Wi-Fi, AI failure detection and system pages that the TV box did not need.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'ai_monitor.dart';
import 'backup.dart';
import 'core.dart';
import 'pi_config.dart';
import 'printer_api.dart';
import 'slicer.dart';
import 'system_control.dart';
import 'updater.dart';

/// Set by the GitHub build (-DFFB_VERSION=1.0.<build number>); "dev" for local builds.
const piBridgeVersion = String.fromEnvironment('FFB_VERSION', defaultValue: 'dev');

/// GitHub repository the update packages come from (-DFFB_REPO=owner/name); empty = no updates.
const updateRepo = String.fromEnvironment('FFB_REPO', defaultValue: '');

class SetupServer {
  final BridgeHost host;
  final PiConfig pi;
  final AiMonitor ai;
  final SystemControl sys;
  final String webDir;
  final int port;
  final Backup? backup;
  final Updater? updater;
  final Slicer? slicer;
  HttpServer? _server;
  List<DiscoveredPrinter> _lastScan = [];
  late final PrinterApi printers = PrinterApi(host);

  SetupServer({required this.host, required this.pi, required this.ai, required this.sys, required this.webDir, this.port = 80, this.backup, this.updater, this.slicer});

  Future<void> start() async {
    _ips = await SystemControl.localIps();
    _ipsAt = DateTime.now();
    _server = await HttpServer.bind(InternetAddress.anyIPv4, port, shared: true);
    _server!.autoCompress = true;
    _server!.listen((req) => _handle(req).catchError((Object e) {
          host.log.warn('Setup page request ${req.uri} failed: $e');
          try {
            req.response.statusCode = 500;
            req.response.close();
          } catch (_) {}
        }));
    host.log.info('Setup page listening on port $port');
  }

  Future<void> stop() async => _server?.close(force: true);

  // ------------------------------------------------------------------ plumbing
  Future<void> _json(HttpRequest req, Object? body, {int status = 200}) async {
    req.response
      ..statusCode = status
      ..headers.contentType = ContentType.json
      ..headers.set('Cache-Control', 'no-store')
      ..write(jsonEncode(body));
    await req.response.close();
  }

  Future<Map<String, dynamic>> _body(HttpRequest req) async {
    final s = await utf8.decodeStream(req);
    if (s.trim().isEmpty) return {};
    final j = jsonDecode(s);
    return j is Map<String, dynamic> ? j : {};
  }

  bool _authorized(HttpRequest req) {
    if (pi.setupPassword.isEmpty) return true;
    final h = req.headers.value(HttpHeaders.authorizationHeader) ?? '';
    if (!h.startsWith('Basic ')) return false;
    try {
      final decoded = utf8.decode(base64.decode(h.substring(6)));
      final pass = decoded.contains(':') ? decoded.substring(decoded.indexOf(':') + 1) : decoded;
      return pass == pi.setupPassword;
    } catch (_) {
      return false;
    }
  }

  Future<void> _handle(HttpRequest req) async {
    final path = req.uri.path;
    if (!_authorized(req)) {
      req.response
        ..statusCode = 401
        ..headers.set('WWW-Authenticate', 'Basic realm="FlashForge Bridge setup"')
        ..write('Password required');
      await req.response.close();
      return;
    }
    if (path.startsWith("/api/")) return await _api(req, path.substring(5));
    return _static(req, path);
  }

  static const _types = {
    'html': 'text/html; charset=utf-8',
    'js': 'application/javascript; charset=utf-8',
    'css': 'text/css; charset=utf-8',
    'svg': 'image/svg+xml',
    'png': 'image/png',
    'ico': 'image/x-icon',
    'json': 'application/json',
    'webmanifest': 'application/manifest+json',
    'txt': 'text/plain; charset=utf-8',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'webp': 'image/webp',
  };

  Future<void> _static(HttpRequest req, String path) async {
    var rel = Uri.decodeComponent(path);
    if (rel.isEmpty || rel == '/' || !rel.contains('.')) rel = '/index.html'; // SPA + captive-portal probes
    if (rel.contains('..')) rel = '/index.html';
    var f = File('$webDir$rel');
    if (!f.existsSync()) f = File('$webDir/index.html');
    final ext = f.path.split('.').last.toLowerCase();
    req.response.headers
      ..set('Content-Type', _types[ext] ?? 'application/octet-stream')
      // the slicer's 3D libraries (1.6 MB) only change with their pinned version
      ..set('Cache-Control', rel.startsWith('/slicer/vendor/') ? 'public, max-age=604800' : 'no-cache');
    await req.response.addStream(f.openRead());
    await req.response.close();
  }

  PrinterBridge? _bridge(String id) => host.instances[id]?.bridge;

  // ------------------------------------------------------------------ API
  Future<void> _api(HttpRequest req, String p) async {
    final m = req.method;
    final seg = p.split('/').where((e) => e.isNotEmpty).toList();
    try {
      // GET /api/status
      if (p == 'status' && m == 'GET') return await _json(req, await _status(req));

      if (slicer != null && await slicer!.handle(req, seg, _json)) return;

      // printers
      if (seg.isNotEmpty && seg[0] == 'printers') {
        if (await printers.handle(req, seg, _json)) return;
        if (seg.length == 1 && m == 'GET') return await _json(req, {'printers': [for (final c in host.config.printers) _printerJson(c, req)]});
        if (seg.length == 2 && seg[1] == 'scan' && m == 'POST') {
          _lastScan = await discoverPrinters(timeout: const Duration(seconds: 5));
          final configured = {for (final c in host.config.printers) c.ip};
          return await _json(req, {
            'found': [for (final f in _lastScan) {...f.toJson(), 'alreadyAdded': configured.contains(f.ip)}]
          });
        }
        if (seg.length == 2 && seg[1] == 'test' && m == 'POST') return await _json(req, await _testPrinter(await _body(req)));
        if (seg.length == 1 && m == 'POST') return await _json(req, await _savePrinter(await _body(req), req));
        if (seg.length == 2 && m == 'DELETE') {
          await host.remove(seg[1]);
          pi.ai.disabledPrinters.remove(seg[1]);
          pi.save();
          return await _json(req, {'ok': true});
        }
        if (seg.length == 3 && seg[2] == 'reconnect' && m == 'POST') {
          await _bridge(seg[1])?.reconnect();
          return await _json(req, {'ok': true});
        }
        if (seg.length == 3 && seg[2] == 'camera' && m == 'GET') {
          final b = _bridge(seg[1]);
          if (b == null || !b.hasCamera) return await _json(req, {'error': 'no camera'}, status: 404);
          return await b.camera.serveStream(req, maxFps: 5);
        }
        if (seg.length == 3 && seg[2] == 'snapshot' && m == 'GET') {
          final jpg = await _bridge(seg[1])?.camera.snapshot();
          if (jpg == null) return await _json(req, {'error': 'no picture'}, status: 404);
          req.response.headers.contentType = ContentType('image', 'jpeg');
          req.response.headers.set('Cache-Control', 'no-store');
          req.response.add(jpg);
          return await req.response.close();
        }
      }

      // integrations (same settings as the TV app's Settings page)
      if (p == 'settings' && m == 'GET') return await _json(req, _settingsJson());
      if (p == 'settings' && m == 'POST') return await _json(req, await _saveSettings(await _body(req)));
      if (p == 'settings/test-spoolman' && m == 'POST') {
        final b = await _body(req);
        final ok = await SpoolmanClient((b['url'] ?? host.config.spoolmanUrl).toString().trim()).ping();
        return await _json(req, {'ok': ok, 'message': ok ? 'Spoolman is reachable.' : 'Spoolman did not answer at that address.'});
      }
      if (p == 'settings/test-discord' && m == 'POST') {
        final b = await _body(req);
        final url = (b['url'] ?? host.config.discordWebhook).toString().trim();
        final d = DiscordNotifier(url);
        if (!d.configured) return await _json(req, {'ok': false, 'message': 'Paste a Discord webhook URL first (it starts with https://).'});
        await d.send(title: 'Test from FlashForge Pi Bridge', description: 'Notifications are working.');
        return await _json(req, {'ok': true, 'message': 'Test message sent. Check your Discord channel.'});
      }

      // AI failure detection
      if (seg.isNotEmpty && seg[0] == 'ai') {
        if (seg.length == 1 && m == 'GET') return await _json(req, _aiJson());
        if (seg.length == 1 && m == 'POST') {
          final b = await _body(req);
          final a = pi.ai;
          if (b['enabled'] is bool) a.enabled = b['enabled'];
          if (b['action'] is String) a.action = b['action'] == 'pause' ? 'pause' : 'notify';
          if (const ['low', 'medium', 'high'].contains(b['sensitivity'])) a.sensitivity = b['sensitivity'];
          if (b['intervalSeconds'] is num) a.intervalSeconds = (b['intervalSeconds'] as num).toInt().clamp(5, 120);
          if (b['printers'] is Map) {
            (b['printers'] as Map).forEach((id, on) {
              if (on == true) {
                a.disabledPrinters.remove(id.toString());
              } else {
                a.disabledPrinters.add(id.toString());
              }
            });
          }
          pi.save();
          return await _json(req, _aiJson());
        }
        if (seg.length == 3 && seg[2] == 'ignore' && m == 'POST') {
          ai.ignore(seg[1]);
          return await _json(req, _aiJson());
        }
        if (seg.length == 3 && seg[2] == 'test' && m == 'POST') {
          final b = _bridge(seg[1]);
          if (b == null) return await _json(req, {'ok': false, 'message': 'Unknown printer'}, status: 404);
          try {
            final s = await ai.runOnce(b);
            final worst = s.lastDetections.fold<double>(0, (x, d) => d.confidence > x ? d.confidence : x);
            return await _json(req, {
              'ok': true,
              'message': 'Analysed one camera picture in ${s.lastInferenceMs} ms. '
                  '${s.lastDetections.isEmpty ? 'Nothing suspicious found.' : '${s.lastDetections.length} suspicious area(s), strongest ${(worst * 100).round()}%.'}',
              'state': s.toJson(),
            });
          } catch (e) {
            return await _json(req, {'ok': false, 'message': e.toString()});
          }
        }
        if (seg.length == 3 && seg[2] == 'image' && m == 'GET') {
          final img = ai.states[seg[1]]?.lastImage;
          if (img == null) return await _json(req, {'error': 'no image yet'}, status: 404);
          req.response.headers.contentType = ContentType('image', 'jpeg');
          req.response.headers.set('Cache-Control', 'no-store');
          req.response.add(img);
          return await req.response.close();
        }
        if (p == 'ai/restart-service' && m == 'POST') return await _json(req, await sys.restartAi());
      }

      // network
      if (p == 'network' && m == 'GET') return await _json(req, await sys.networkStatus());
      if (p == 'printer-network' && m == 'GET') return await _json(req, await sys.printerNetStatus());
      if (p == 'printer-network' && m == 'POST') {
        final b = await _body(req);
        switch (b['action']) {
          case 'enable':
            return await _json(req, await sys.printerNetEnable('${b['ssid'] ?? ''}'.trim(), '${b['password'] ?? ''}'));
          case 'disable':
            return await _json(req, await sys.printerNetDisable());
          case 'internet':
            final mins = b['minutes'] is num ? (b['minutes'] as num).toInt() : int.tryParse('${b['minutes']}') ?? 0;
            return await _json(req, await sys.printerNetInternet(mins.clamp(-1, 24 * 60)));
        }
        return await _json(req, {'ok': false, 'message': 'Unknown action.'}, status: 400);
      }
      if (p == 'network/scan' && m == 'POST') return await _json(req, await sys.wifiScan());
      if (p == 'network/connect' && m == 'POST') {
        final b = await _body(req);
        final ssid = (b['ssid'] ?? '').toString();
        if (ssid.trim().isEmpty) return await _json(req, {'ok': false, 'message': 'Pick or type a Wi-Fi network name.'});
        // Answer first: when the board is in hotspot mode, the phone loses this connection.
        final fut = sys.wifiConnect(ssid, (b['password'] ?? '').toString());
        final r = await fut.timeout(const Duration(seconds: 80), onTimeout: () => {'ok': false, 'message': 'Still trying... check again in a minute.'});
        return await _json(req, r);
      }
      if (p == 'network/hostname' && m == 'POST') {
        final b = await _body(req);
        final name = (b['hostname'] ?? '').toString().toLowerCase().replaceAll(RegExp('[^a-z0-9-]'), '');
        if (name.isEmpty || name.length > 32) return await _json(req, {'ok': false, 'message': 'Use letters, numbers and dashes only.'});
        return await _json(req, await sys.setHostname(name));
      }

      // updates
      if (p == 'update' && m == 'GET') return await _json(req, updater?.toJson() ?? {'configured': false, 'current': piBridgeVersion});
      if (p == 'update/check' && m == 'POST' && updater != null) {
        await updater!.check();
        return await _json(req, updater!.toJson());
      }
      if (p == 'update/install' && m == 'POST' && updater != null) return await _json(req, await updater!.install());

      // backup / restore
      if (p == 'backup' && m == 'GET' && backup != null) {
        final day = DateTime.now().toIso8601String().substring(0, 10);
        req.response.headers
          ..contentType = ContentType.json
          ..set('Content-Disposition', 'attachment; filename="ffbridge-backup-$day.json"')
          ..set('Cache-Control', 'no-store');
        req.response.write(const JsonEncoder.withIndent(' ').convert(backup!.build()));
        return await req.response.close();
      }
      if (p == 'backup/restore' && m == 'POST' && backup != null) {
        Object? j;
        try {
          j = jsonDecode(await utf8.decodeStream(req));
        } catch (_) {
          return await _json(req, {'ok': false, 'message': 'That file could not be read. Pick the .json backup file.'});
        }
        final err = Backup.validate(j);
        if (err != null) return await _json(req, {'ok': false, 'message': err});
        backup!.restore(j as Map);
        host.log.info('Settings restored from an uploaded backup (made ${j['created']}). Restarting the bridge.');
        final managed = Platform.environment.containsKey('INVOCATION_ID'); // running under systemd
        if (managed) Timer(const Duration(seconds: 1), () => exit(0)); // systemd starts it again with the restored settings
        return await _json(req, {
          'ok': true,
          'restarting': managed,
          'message': managed ? 'Settings restored. The bridge restarts — this page reloads in a few seconds.' : 'Settings restored. Restart the bridge to use them.',
        });
      }

      // system
      if (p == 'logs' && m == 'GET') return await _json(req, {'lines': host.log.lines.toList()});
      if (p == 'system/reboot' && m == 'POST') {
        Timer(const Duration(seconds: 1), sys.reboot);
        return await _json(req, {'ok': true, 'message': 'Restarting. This takes about a minute.'});
      }
      if (p == 'system/shutdown' && m == 'POST') {
        Timer(const Duration(seconds: 1), sys.shutdown);
        return await _json(req, {'ok': true, 'message': 'Shutting down. Wait 30 seconds before unplugging.'});
      }
      if (p == 'system/password' && m == 'POST') {
        final b = await _body(req);
        pi.setupPassword = (b['password'] ?? '').toString();
        pi.save();
        return await _json(req, {'ok': true, 'message': pi.setupPassword.isEmpty ? 'Password removed.' : 'Password set. Your browser will ask for it next time (any user name works).'});
      }
      if (p == 'system/info' && m == 'GET') return await _json(req, await sys.systemInfo());

      return await _json(req, {'error': 'not found'}, status: 404);
    } catch (e) {
      host.log.warn('API $m /api/$p failed: $e');
      return await _json(req, {'ok': false, 'message': e.toString()}, status: 500);
    }
  }

  String _hostFor(HttpRequest req) {
    final h = req.headers.host ?? SystemControl.hostname();
    return h.contains(':') && !h.startsWith('[') ? h.substring(0, h.indexOf(':')) : h;
  }

  List<String> _ips = [];
  DateTime _ipsAt = DateTime(2000);

  /// Best address to give OrcaSlicer: the board's LAN IP (not the setup hotspot), else the name.
  String _orcaHost(HttpRequest req) {
    if (DateTime.now().difference(_ipsAt).inSeconds > 30) {
      _ipsAt = DateTime.now();
      SystemControl.localIps().then((v) => _ips = v);
    }
    final lan = _ips.where((ip) => !ip.startsWith('10.42.') && !ip.startsWith('10.43.') && !ip.startsWith('169.254.') && !ip.startsWith('172.17.')).toList();
    return lan.isNotEmpty ? lan.first : _hostFor(req);
  }

  Map<String, dynamic> _printerJson(PrinterConfig c, HttpRequest req) {
    final b = _bridge(c.id);
    final d = b?.client.last;
    final h = _hostFor(req);
    final orca = _orcaHost(req);
    return {
      'id': c.id,
      'name': c.name,
      'ip': c.ip,
      'serial': c.serial,
      'hasCheckCode': c.checkCode.isNotEmpty,
      'port': c.port,
      'model': c.model,
      'enabled': c.enabled,
      'levelBeforePrint': c.levelBeforePrint,
      'autoClearPlatform': c.autoClearPlatform,
      'cameraUrl': c.cameraUrl,
      'mainsailUrl': 'http://$h:${c.port}/',
      'orcaHost': '$orca:${c.port}',
      'orcaHostName': '${SystemControl.hostname()}.local:${c.port}',
      'error': host.instances[c.id]?.error,
      'online': b?.online ?? false,
      'stateMessage': b?.stateMessage ?? (c.enabled ? 'Starting...' : 'Disabled'),
      'jobState': b?.jobState ?? 'standby',
      'jobFile': b?.jobFile ?? '',
      'progress': d?.printProgress ?? 0,
      'layer': d?.printLayer ?? 0,
      'layers': d?.targetPrintLayer ?? 0,
      'remaining': d?.estimatedTime ?? 0,
      'elapsed': d?.printDuration ?? 0,
      'tools': [for (final t in d?.toolTemps ?? const <Temp>[]) t.toJson()],
      'bed': d?.bed.toJson(),
      'chamber': (d?.hasChamberReading ?? false) ? d!.chamber.toJson() : null,
      'hasCamera': b?.hasCamera ?? false,
      'firmware': b?.client.firmware ?? '',
      'uploadStatus': b?.uploadStatus ?? '',
      'waitingForSlots': b?.pendingMapping?.file,
      'ai': ai.stateFor(c.id).toJson(),
      'aiEnabled': pi.ai.enabledFor(c.id),
      ...printers.liveJson(b),
    };
  }

  Future<Map<String, dynamic>> _status(HttpRequest req) async => {
        'version': piBridgeVersion,
        'hostname': SystemControl.hostname(),
        'ips': await SystemControl.localIps(),
        'boardControls': sys.available,
        'passwordSet': pi.setupPassword.isNotEmpty,
        'printers': [for (final c in host.config.printers) _printerJson(c, req)],
        'aiService': ai.service.toJson(),
        'aiEnabled': pi.ai.enabled,
        'update': {'available': updater?.available ?? false, 'latest': updater?.latest?['version']},
        'slicer': {'enabled': pi.slicerEnabled && slicer != null, 'installed': slicer?.installed ?? false},
      };

  Future<Map<String, dynamic>> _testPrinter(Map<String, dynamic> b) async {
    var code = (b['checkCode'] ?? '').toString().trim();
    final id = (b['id'] ?? '').toString();
    if (code.isEmpty && id.isNotEmpty) {
      code = host.config.printers.firstWhere((p) => p.id == id, orElse: () => PrinterConfig(id: '', name: '', ip: '', serial: '', checkCode: '')).checkCode;
    }
    final ip = (b['ip'] ?? '').toString().trim();
    var serial = (b['serial'] ?? '').toString().trim();
    if (ip.isEmpty) return {'ok': false, 'message': 'Enter the printer\'s IP address.'};
    if (serial.isEmpty) serial = await _findSerial(ip) ?? '';
    if (serial.isEmpty) return {'ok': false, 'message': 'Could not find the serial number automatically. Type it in (printer: Settings → About).'};
    if (code.isEmpty) return {'ok': false, 'message': 'Enter the pairing code shown on the printer in LAN-only mode.'};
    final c = FlashForgeClient(ip, serial, code);
    try {
      final d = await c.connect().timeout(const Duration(seconds: 15));
      return {
        'ok': true,
        'message': 'Connected: ${d.model} "${d.name}", firmware ${d.firmwareVersion}.',
        'name': d.name,
        'model': d.model,
        'serial': serial,
      };
    } catch (e) {
      return {'ok': false, 'message': _friendlyError(e)};
    } finally {
      await c.dispose().catchError((_) {});
    }
  }

  String _friendlyError(Object e) {
    final s = e.toString();
    if (s.contains('Pairing rejected') || s.contains('rejected')) return 'The printer refused the pairing code. Check it on the printer (Settings → Network → LAN-only mode) and try again.';
    if (s.contains('SocketException') || s.contains('timed out') || s.contains('TimeoutException')) {
      return 'Could not reach the printer at that address. Is it switched on, on the same network, and in LAN-only mode?';
    }
    return s;
  }

  Future<String?> _findSerial(String ip) async {
    for (final f in _lastScan) {
      if (f.ip == ip && f.serial.isNotEmpty) return f.serial;
    }
    final r = await discoverPrinters(timeout: const Duration(seconds: 4));
    _lastScan = r;
    for (final f in r) {
      if (f.ip == ip && f.serial.isNotEmpty) return f.serial;
    }
    return null;
  }

  Future<Map<String, dynamic>> _savePrinter(Map<String, dynamic> b, HttpRequest req) async {
    final id = (b['id'] ?? '').toString();
    final existing = host.config.printers.where((p) => p.id == id).firstOrNull;
    final ip = (b['ip'] ?? '').toString().trim();
    if (ip.isEmpty) return {'ok': false, 'message': 'Enter the printer\'s IP address.'};
    var serial = (b['serial'] ?? '').toString().trim();
    if (serial.isEmpty) serial = await _findSerial(ip) ?? existing?.serial ?? '';
    final code = (b['checkCode'] ?? '').toString().trim();
    final port = (b['port'] is num) ? (b['port'] as num).toInt() : int.tryParse('${b['port'] ?? ''}') ?? existing?.port ?? host.config.nextFreePort();
    if (port < 1024 || port > 65535) return {'ok': false, 'message': 'Port must be between 1024 and 65535.'};
    if (host.config.printers.any((p) => p.port == port && p.id != id)) return {'ok': false, 'message': 'Another printer already uses port $port.'};
    final cfg = existing ??
        PrinterConfig(id: 'p${DateTime.now().millisecondsSinceEpoch}', name: 'FlashForge', ip: ip, serial: serial, checkCode: code, port: port);
    final name = (b['name'] ?? '').toString().trim();
    cfg
      ..name = name.isEmpty ? (existing?.name ?? 'FlashForge') : name
      ..ip = ip
      ..serial = serial
      ..checkCode = code.isEmpty ? cfg.checkCode : code
      ..port = port
      ..cameraUrl = (b['cameraUrl'] ?? cfg.cameraUrl).toString().trim()
      ..levelBeforePrint = b['levelBeforePrint'] is bool ? b['levelBeforePrint'] : cfg.levelBeforePrint
      ..autoClearPlatform = b['autoClearPlatform'] is bool ? b['autoClearPlatform'] : cfg.autoClearPlatform
      ..enabled = b['enabled'] is bool ? b['enabled'] : cfg.enabled;
    if (cfg.serial.isEmpty) return {'ok': false, 'message': 'Serial number is missing and the printer was not found by a network scan. Type it in.'};
    if (cfg.checkCode.isEmpty) return {'ok': false, 'message': 'Enter the pairing code shown on the printer in LAN-only mode.'};
    await host.addOrUpdate(cfg);
    host.log.info('Printer saved: ${cfg.name} ${cfg.ip} (port ${cfg.port})');
    return {'ok': true, 'printer': _printerJson(cfg, req)};
  }

  Map<String, dynamic> _settingsJson() {
    final c = host.config;
    return {
      'spoolmanUrl': c.spoolmanUrl,
      'discordWebhook': c.discordWebhook,
      'discordIntervalMinutes': c.discordIntervalMinutes,
      'discordSnapshot': c.discordSnapshot,
      'notifyOnStart': c.notifyOnStart,
      'notifyOnComplete': c.notifyOnComplete,
      'notifyOnPause': c.notifyOnPause,
      'notifyOnError': c.notifyOnError,
      'mappingMode': c.mappingMode,
    };
  }

  Future<Map<String, dynamic>> _saveSettings(Map<String, dynamic> b) async {
    final c = host.config;
    final oldInterval = c.discordIntervalMinutes;
    if (b['spoolmanUrl'] is String) c.spoolmanUrl = (b['spoolmanUrl'] as String).trim();
    if (b['discordWebhook'] is String) c.discordWebhook = (b['discordWebhook'] as String).trim();
    if (b['mappingMode'] == 'auto' || b['mappingMode'] == 'always') c.mappingMode = b['mappingMode'];
    if (b['discordIntervalMinutes'] is num) c.discordIntervalMinutes = (b['discordIntervalMinutes'] as num).toInt().clamp(0, 1440);
    for (final k in ['discordSnapshot', 'notifyOnStart', 'notifyOnComplete', 'notifyOnPause', 'notifyOnError']) {
      if (b[k] is! bool) continue;
      switch (k) {
        case 'discordSnapshot':
          c.discordSnapshot = b[k];
        case 'notifyOnStart':
          c.notifyOnStart = b[k];
        case 'notifyOnComplete':
          c.notifyOnComplete = b[k];
        case 'notifyOnPause':
          c.notifyOnPause = b[k];
        case 'notifyOnError':
          c.notifyOnError = b[k];
      }
    }
    host.applyIntegrations();
    if (oldInterval != c.discordIntervalMinutes) {
      // The progress timer is created when a printer connection starts: restart them.
      for (final p in c.printers.where((p) => p.enabled).toList()) {
        await host.startPrinter(p);
      }
    }
    return {'ok': true, ..._settingsJson()};
  }

  Map<String, dynamic> _aiJson() => {
        'settings': pi.ai.toJson(),
        'service': ai.service.toJson(),
        'printers': [
          for (final c in host.config.printers) {'id': c.id, 'name': c.name, 'enabled': pi.ai.enabledFor(c.id), 'state': ai.stateFor(c.id).toJson()}
        ],
      };
}
