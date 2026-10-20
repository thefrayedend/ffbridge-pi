// Moonraker API emulation (WebSocket JSON-RPC + HTTP) and static Mainsail hosting.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../bridge.dart';
import '../ff/models.dart' show MaterialMapping;
import '../gcode.dart';
import '../util/multipart.dart';
import 'file_manager.dart';

const moonrakerVersion = 'v0.9.3-120-gffbridge';
const klipperVersion = 'v0.13.0-150-gffbridge';

class _Conn {
  final int id;
  final WebSocket ws;
  Map<String, List<String>?> subs = {};
  Map<String, dynamic> info = {};
  _Conn(this.id, this.ws);
}

class MoonrakerServer {
  final PrinterBridge b;
  final String webRoot; // extracted Mainsail directory
  final int port;
  HttpServer? _server;
  final _conns = <int, _Conn>{};
  int _nextConn = 1000;
  late final GcodeRunner gcode = GcodeRunner(b);
  StreamSubscription? _sub;
  Timer? _procTimer;
  final DateTime _start = DateTime.now();

  MoonrakerServer(this.b, this.webRoot, this.port);

  int get connectionCount => _conns.length;

  Future<void> start() async {
    _server = await HttpServer.bind(InternetAddress.anyIPv4, port, shared: true);
    _server!.autoCompress = true;
    _server!.idleTimeout = const Duration(seconds: 120);
    _server!.listen((req) => _handle(req).catchError((e) {
          try {
            req.response.statusCode = 500;
            req.response.close();
          } catch (_) {}
        }));
    _sub = b.notifications.listen(_broadcast);
    _procTimer = Timer.periodic(const Duration(seconds: 2), (_) {
      if (_conns.isEmpty) return;
      _broadcast({
        'jsonrpc': '2.0',
        'method': 'notify_proc_stat_update',
        'params': [_procStatUpdate()]
      });
    });
    b.log.info('Moonraker/Mainsail server listening on port $port');
  }

  Future<void> stop() async {
    _procTimer?.cancel();
    await _sub?.cancel();
    for (final c in _conns.values) {
      await c.ws.close();
    }
    await _server?.close(force: true);
  }

  void _broadcast(Map<String, dynamic> msg) {
    if (_conns.isEmpty) return;
    if (msg['method'] == 'notify_status_update') {
      final diff = (msg['params'] as List)[0] as Map<String, dynamic>;
      final et = (msg['params'] as List)[1];
      for (final c in _conns.values) {
        final filtered = <String, dynamic>{};
        diff.forEach((obj, fields) {
          if (!c.subs.containsKey(obj)) return;
          final want = c.subs[obj];
          if (want == null) {
            filtered[obj] = fields;
          } else {
            final f = <String, dynamic>{};
            (fields as Map<String, dynamic>).forEach((k, v) {
              if (want.contains(k)) f[k] = v;
            });
            if (f.isNotEmpty) filtered[obj] = f;
          }
        });
        if (filtered.isNotEmpty) {
          _send(c, {
            'jsonrpc': '2.0',
            'method': 'notify_status_update',
            'params': [filtered, et]
          });
        }
      }
      return;
    }
    final text = jsonEncode(msg);
    for (final c in _conns.values) {
      try {
        c.ws.add(text);
      } catch (_) {}
    }
  }

  void _send(_Conn c, Object msg) {
    try {
      c.ws.add(jsonEncode(msg));
    } catch (_) {}
  }

  // ======================= HTTP =======================
  void _cors(HttpResponse r) {
    r.headers
      ..set('Access-Control-Allow-Origin', '*')
      ..set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      ..set('Access-Control-Allow-Headers', 'Origin, Accept, Content-Type, X-Requested-With, X-CRSF-Token, Authorization, X-Api-Key');
  }

  Future<void> _json(HttpRequest req, Object? result, {int status = 200}) async {
    final r = req.response;
    r.statusCode = status;
    r.headers.contentType = ContentType.json;
    r.headers.set('Cache-Control', 'no-cache');
    r.write(jsonEncode(status == 200 ? {'result': result} : result));
    await r.close();
  }

  Future<void> _error(HttpRequest req, int code, String message) =>
      _json(req, {'error': {'code': code, 'message': message, 'traceback': ''}}, status: code);

  Future<void> _handle(HttpRequest req) async {
    final path = Uri.decodeComponent(req.uri.path);
    _cors(req.response);
    if (req.method == 'OPTIONS') {
      req.response.statusCode = 204;
      await req.response.close();
      return;
    }
    if (path == '/websocket') {
      if (WebSocketTransformer.isUpgradeRequest(req)) {
        final ws = await WebSocketTransformer.upgrade(req, compression: CompressionOptions.compressionDefault);
        ws.pingInterval = const Duration(seconds: 20);
        _onSocket(ws);
      } else {
        await _error(req, 400, 'WebSocket upgrade required');
      }
      return;
    }
    if (path == '/webcam' || path.startsWith('/webcam/')) return _webcam(req);
    try {
      if (path == '/server/files/upload' && req.method == 'POST') return await _upload(req, octo: false);
      if (path == '/api/files/local' && req.method == 'POST') return await _upload(req, octo: true);
      if (path.startsWith('/server/files/') && !path.startsWith('/server/files/list') && !path.startsWith('/server/files/metadata') &&
          !path.startsWith('/server/files/directory') && !path.startsWith('/server/files/roots') && !path.startsWith('/server/files/move') &&
          !path.startsWith('/server/files/copy') && !path.startsWith('/server/files/thumbnails') && !path.startsWith('/server/files/zip')) {
        return await _fileRequest(req, path.substring('/server/files/'.length));
      }
      if (path.startsWith('/api/')) return await _octo(req, path);
      if (path == '/access/oneshot_token') return await _json(req, 'ffbridge');
      if (path == '/access/info') return await _json(req, {'default_source': 'moonraker', 'available_sources': ['moonraker']});
      if (path == '/server/jsonrpc' && req.method == 'POST') {
        final body = jsonDecode(await utf8.decodeStream(req));
        final res = await _dispatchRpc(null, body['method'], body['params'] ?? {});
        return await _rawJson(req, {'jsonrpc': '2.0', 'result': res, 'id': body['id']});
      }
      final segs = path.split('/').where((s) => s.isNotEmpty).toList();
      if (segs.length >= 2 && const ['server', 'printer', 'machine', 'access'].contains(segs.first)) {
        final params = <String, dynamic>{};
        req.uri.queryParametersAll.forEach((k, v) => params[k] = v.length == 1 ? v.first : v);
        if (req.method == 'POST' || req.method == 'PUT' || req.method == 'DELETE') {
          final ct = req.headers.contentType?.mimeType ?? '';
          final text = await utf8.decodeStream(req);
          if (ct == 'application/json' && text.isNotEmpty) {
            final j = jsonDecode(text);
            if (j is Map) params.addAll(Map<String, dynamic>.from(j));
          }
        }
        // printer/objects/query?extruder&heater_bed=temperature,target
        if (path == '/printer/objects/query' || path == '/printer/objects/subscribe') {
          final objs = <String, dynamic>{};
          req.uri.queryParameters.forEach((k, v) => objs[k] = v.isEmpty ? null : v.split(','));
          params
            ..clear()
            ..['objects'] = objs;
        }
        var method = segs.join('.');
        method = _httpMethodAlias(req.method, method);
        final res = await _dispatchRpc(null, method, params);
        return await _json(req, res);
      }
      return await _static(req, path);
    } on RpcError catch (e) {
      return _error(req, e.code, e.message);
    } catch (e) {
      return _error(req, 500, e.toString());
    }
  }

  String _httpMethodAlias(String verb, String m) {
    // REST verbs that map onto distinct JSON-RPC methods
    const map = {
      'GET server.database.item': 'server.database.get_item',
      'POST server.database.item': 'server.database.post_item',
      'DELETE server.database.item': 'server.database.delete_item',
      'GET server.history.job': 'server.history.get_job',
      'DELETE server.history.job': 'server.history.delete_job',
      'POST server.files.directory': 'server.files.post_directory',
      'DELETE server.files.directory': 'server.files.delete_directory',
      'GET server.files.directory': 'server.files.get_directory',
      'GET server.webcams.item': 'server.webcams.get_item',
      'POST server.webcams.item': 'server.webcams.post_item',
      'DELETE server.webcams.item': 'server.webcams.delete_item',
      'GET server.job_queue.status': 'server.job_queue.status',
      'POST server.spoolman.spool_id': 'server.spoolman.post_spool_id',
      'GET server.spoolman.spool_id': 'server.spoolman.get_spool_id',
    };
    return map['$verb $m'] ?? m;
  }

  Future<void> _static(HttpRequest req, String path) async {
    var p = path == '/' ? '/index.html' : path;
    if (p.contains('..')) return _error(req, 403, 'Forbidden');
    var f = File('$webRoot$p');
    if (!f.existsSync()) {
      if (p.contains('.') && !p.endsWith('.html')) return _error(req, 404, 'Not Found');
      f = File('$webRoot/index.html'); // SPA fallback
      p = '/index.html';
    }
    if (!f.existsSync()) {
      req.response.headers.contentType = ContentType.html;
      req.response.write('<h1>FlashForge TV Bridge</h1><p>Web UI not installed yet.</p>');
      return req.response.close();
    }
    final r = req.response;
    r.headers.contentType = _mime(p);
    if (p == '/index.html' || p == '/config.json' || p.endsWith('sw.js') || p.endsWith('.webmanifest')) {
      r.headers.set('Cache-Control', 'no-cache');
    } else {
      r.headers.set('Cache-Control', 'public, max-age=86400');
    }
    await r.addStream(f.openRead());
    await r.close();
  }

  static ContentType _mime(String p) {
    final ext = p.split('.').last.toLowerCase();
    const m = {
      'html': 'text/html; charset=utf-8',
      'js': 'application/javascript; charset=utf-8',
      'mjs': 'application/javascript; charset=utf-8',
      'css': 'text/css; charset=utf-8',
      'json': 'application/json; charset=utf-8',
      'webmanifest': 'application/manifest+json',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'svg': 'image/svg+xml',
      'ico': 'image/x-icon',
      'woff': 'font/woff',
      'woff2': 'font/woff2',
      'ttf': 'font/ttf',
      'gcode': 'text/plain; charset=utf-8',
      'txt': 'text/plain; charset=utf-8',
      'log': 'text/plain; charset=utf-8',
      'cfg': 'text/plain; charset=utf-8',
      'wasm': 'application/wasm',
    };
    return ContentType.parse(m[ext] ?? 'application/octet-stream');
  }

  Future<void> _webcam(HttpRequest req) async {
    final action = req.uri.queryParameters['action'] ?? 'stream';
    if (!b.hasCamera) return _error(req, 404, 'No camera');
    if (action == 'snapshot') {
      final jpg = await b.camera.snapshot();
      if (jpg == null) return _error(req, 503, 'Camera unavailable');
      req.response.headers
        ..contentType = ContentType('image', 'jpeg')
        ..set('Cache-Control', 'no-cache');
      req.response.add(jpg);
      return req.response.close();
    }
    final fps = int.tryParse(req.uri.queryParameters['fps'] ?? '') ?? 0;
    await b.camera.serveStream(req, maxFps: fps);
  }

  Future<void> _fileRequest(HttpRequest req, String rel) async {
    final (root, path) = b.files.splitPath(rel);
    if (req.method == 'DELETE') {
      b.files.deleteFile(rel);
      _fileChanged('delete_file', root, path);
      return _json(req, {'item': {'path': path, 'root': root}, 'action': 'delete_file'});
    }
    final f = b.files.fileFor(root, path);
    if (!f.existsSync()) {
      // printer-only thumbnails live in .thumbs too; anything else is 404
      return _error(req, 404, 'File not found: $rel');
    }
    final r = req.response;
    r.headers.contentType = _mime(path);
    r.headers.set('Cache-Control', path.contains('.thumbs/') ? 'public, max-age=3600' : 'no-cache');
    if (req.uri.queryParameters.containsKey('download') || !path.contains('.thumbs/')) {
      r.headers.set('Content-Disposition', 'inline; filename="${path.split('/').last}"');
    }
    r.contentLength = f.lengthSync();
    await r.addStream(f.openRead());
    await r.close();
  }

  void _fileChanged(String action, String root, String path, {String? sourcePath}) {
    b.emitRaw('notify_filelist_changed', [
      {
        'action': action,
        'item': {...b.files.itemInfo(root, path), 'root': root, 'path': path},
        if (sourcePath != null) 'source_item': {'path': sourcePath, 'root': root},
      }
    ]);
  }

  Future<void> _upload(HttpRequest req, {required bool octo}) async {
    final ct = req.headers.contentType;
    final boundary = ct?.parameters['boundary'];
    if (boundary == null) throw RpcError(400, 'Expected multipart/form-data');
    final tmp = File('${b.dataDir}/upload_${DateTime.now().microsecondsSinceEpoch}.tmp');
    final mp = await parseMultipart(req, boundary, tmp);
    if (mp.file == null) throw RpcError(400, 'No file in upload');
    final root = mp.fields['root'] ?? 'gcodes';
    if (root != 'gcodes') {
      tmp.deleteSync();
      throw RpcError(403, 'Uploads are only allowed to gcodes');
    }
    var dir = b.files.safeRel(mp.fields['path'] ?? '');
    var name = (mp.fields['filename'] ?? mp.fileName ?? 'upload.gcode').split('/').last.split('\\').last;
    // OrcaSlicer may put a sub path into the filename
    final rel = dir.isEmpty ? name : '$dir/$name';
    final dest = b.files.fileFor('gcodes', rel);
    dest.parent.createSync(recursive: true);
    if (dest.existsSync()) dest.deleteSync();
    tmp.renameSync(dest.path);
    await b.files.scanMetadata(rel);
    final printReq = (mp.fields['print'] ?? 'false').toLowerCase() == 'true';
    _fileChanged('create_file', 'gcodes', rel);
    b.gcodeResponse('// Received $rel (${(mp.fileSize / 1024 / 1024).toStringAsFixed(1)} MB)');
    var started = false;
    if (b.online) {
      try {
        if (printReq) {
          await b.uploadToPrinter(dest, name, printNow: false);
          await b.startPrint(rel);
          started = true;
        } else {
          await b.uploadToPrinter(dest, name, printNow: false);
        }
      } catch (e) {
        b.gcodeResponse('!! Forwarding $name to the printer failed: $e');
        if (printReq) throw RpcError(500, 'Upload to printer failed: $e');
      }
    } else if (printReq) {
      throw RpcError(503, 'Printer is offline; file was saved but not printed');
    }
    final item = {'path': rel, 'root': 'gcodes', 'modified': DateTime.now().millisecondsSinceEpoch / 1000.0, 'size': mp.fileSize, 'permissions': 'rw'};
    if (octo) {
      req.response.statusCode = 201;
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode({
        'done': true,
        'files': {
          'local': {'name': name, 'origin': 'local', 'path': rel, 'refs': {'resource': '/api/files/local/$rel'}}
        },
        'print_started': started,
      }));
      return req.response.close();
    }
    req.response.statusCode = 201;
    req.response.headers.contentType = ContentType.json;
    req.response.write(jsonEncode({'item': item, 'print_started': started, 'print_queued': false, 'action': 'create_file'}));
    await req.response.close();
  }

  Future<void> _octo(HttpRequest req, String path) async {
    switch (path) {
      case '/api/version':
        return _rawJson(req, {'server': '1.5.0', 'api': '0.1', 'text': 'OctoPrint (Moonraker $moonrakerVersion)'});
      case '/api/server':
        return _rawJson(req, {'server': '1.5.0', 'safemode': null});
      case '/api/login':
        return _rawJson(req, {'_is_external_client': false, '_login_mechanism': 'apikey', 'name': '_api', 'active': true, 'user': true, 'admin': true, 'apikey': null, 'permissions': [], 'groups': ['admins', 'users']});
      case '/api/settings':
        return _rawJson(req, {'plugins': {'UltimakerFormatPackage': {'align_inline_thumbnail': false, 'inline_thumbnail': false}}, 'feature': {'sdSupport': false, 'temperatureGraph': false}, 'webcam': {'flipH': false, 'flipV': false, 'rotate90': false, 'streamUrl': '/webcam/?action=stream', 'webcamEnabled': b.hasCamera}});
      case '/api/job':
        final ps = b.status['print_stats'] ?? {};
        final d = b.client.last;
        return _rawJson(req, {
          'job': {'file': {'name': ps['filename']}, 'estimatedPrintTime': null, 'filament': {'length': ps['filament_used']}, 'user': null},
          'progress': {'completion': (d?.printProgress ?? 0) * 100, 'filepos': 0, 'printTime': ps['print_duration'], 'printTimeLeft': d?.estimatedTime, 'printTimeOrigin': 'linear'},
          'state': {'printing': 'Printing', 'paused': 'Paused', 'complete': 'Operational', 'standby': 'Operational', 'cancelled': 'Operational', 'error': 'Error'}[b.jobState] ?? 'Offline',
        });
      case '/api/printer':
        final temps = <String, dynamic>{};
        for (final e in b.status.entries) {
          if (e.value.containsKey('temperature')) {
            final key = e.key == 'heater_bed' ? 'bed' : (e.key == 'extruder' ? 'tool0' : e.key.replaceFirst('extruder', 'tool').replaceFirst('heater_generic chamber', 'chamber'));
            temps[key] = {'actual': e.value['temperature'], 'target': e.value['target'], 'offset': 0};
          }
        }
        return _rawJson(req, {
          'temperature': temps,
          'state': {
            'text': b.jobState,
            'flags': {'operational': b.online, 'paused': b.jobState == 'paused', 'printing': b.jobState == 'printing', 'cancelling': false, 'pausing': false, 'error': b.jobState == 'error', 'ready': b.online && b.jobState != 'printing', 'closedOrError': !b.online}
          }
        });
      case '/api/printer/command':
        final body = jsonDecode(await utf8.decodeStream(req));
        final cmds = (body['commands'] as List?)?.cast<String>() ?? [if (body['command'] != null) body['command'] as String];
        await gcode.runScript(cmds.join('\n'));
        return _rawJson(req, {});
      case '/api/printerprofiles':
        return _rawJson(req, {'profiles': {'_default': {'id': '_default', 'name': 'Default', 'color': 'default', 'model': b.client.model, 'default': true, 'current': true, 'heatedBed': true, 'heatedChamber': b.client.caps.chamber}}});
    }
    return _error(req, 404, 'Not found');
  }

  Future<void> _rawJson(HttpRequest req, Object o) async {
    req.response.headers.contentType = ContentType.json;
    req.response.write(jsonEncode(o));
    await req.response.close();
  }

  // ======================= WebSocket JSON-RPC =======================
  void _onSocket(WebSocket ws) {
    final c = _Conn(_nextConn++, ws);
    _conns[c.id] = c;
    ws.listen((data) async {
      dynamic msg;
      try {
        msg = jsonDecode(data as String);
      } catch (_) {
        _send(c, {'jsonrpc': '2.0', 'error': {'code': -32700, 'message': 'Parse error'}, 'id': null});
        return;
      }
      if (msg is List) {
        final results = await Future.wait(msg.map((m) => _handleRpc(c, m)));
        _send(c, results.where((r) => r != null).toList());
      } else {
        final r = await _handleRpc(c, msg);
        if (r != null) _send(c, r);
      }
    }, onDone: () => _conns.remove(c.id), onError: (_) => _conns.remove(c.id), cancelOnError: true);
  }

  Future<Map<String, dynamic>?> _handleRpc(_Conn c, dynamic msg) async {
    if (msg is! Map) return null;
    final id = msg['id'];
    final method = msg['method']?.toString() ?? '';
    final params = msg['params'] is Map ? Map<String, dynamic>.from(msg['params']) : <String, dynamic>{};
    try {
      final res = await _dispatchRpc(c, method, params);
      if (id == null) return null;
      return {'jsonrpc': '2.0', 'result': res, 'id': id};
    } on RpcError catch (e) {
      if (method == 'printer.gcode.script') b.gcodeResponse('!! ${e.message}');
      return {'jsonrpc': '2.0', 'error': {'code': e.code, 'message': e.message}, 'id': id};
    } catch (e, st) {
      b.log.warn('RPC $method failed: $e\n$st');
      return {'jsonrpc': '2.0', 'error': {'code': 500, 'message': e.toString()}, 'id': id};
    }
  }

  Map<String, dynamic> _query(Map<String, dynamic> objects) {
    final out = <String, dynamic>{};
    objects.forEach((name, fields) {
      final s = b.status[name];
      if (s == null) return;
      if (fields == null || (fields is List && fields.isEmpty)) {
        out[name] = s;
      } else {
        final want = (fields is List) ? fields.map((e) => e.toString()).toList() : fields.toString().split(',');
        out[name] = {for (final k in want) if (s.containsKey(k)) k: s[k]};
      }
    });
    return out;
  }

  Map<String, dynamic> _procStatUpdate() => {
        'moonraker_stats': {'time': DateTime.now().millisecondsSinceEpoch / 1000.0, 'cpu_usage': 1.0, 'memory': 40000, 'mem_units': 'kB'},
        'cpu_temp': null,
        'network': {},
        'system_cpu_usage': {'cpu': 5.0},
        'system_memory': {'total': 2048000, 'available': 1024000, 'used': 1024000},
        'websocket_connections': _conns.length,
      };

  List<String> get _components => [
        'secrets',
        'template',
        'klippy_connection',
        'jsonrpc',
        'internal_transport',
        'application',
        'websockets',
        'dbus_manager',
        'database',
        'file_manager',
        'klippy_apis',
        'machine',
        'data_store',
        'shell_command',
        'proc_stats',
        'job_state',
        'job_queue',
        'history',
        'octoprint_compat',
        'webcam',
        'extensions',
        if (b.spoolman.configured) 'spoolman',
      ];

  Future<dynamic> _dispatchRpc(_Conn? c, String method, Map<String, dynamic> p) async {
    final f = b.files;
    switch (method) {
      case 'server.connection.identify':
        if (c != null) c.info = p;
        return {'connection_id': c?.id ?? 0};
      case 'server.websocket.id':
        return {'websocket_id': c?.id ?? 0};
      case 'server.info':
        return {
          'klippy_connected': true,
          'klippy_state': b.online ? 'ready' : 'shutdown',
          'components': _components,
          'failed_components': [],
          'registered_directories': f.roots,
          'warnings': [],
          'websocket_count': _conns.length,
          'moonraker_version': moonrakerVersion,
          'missing_klippy_requirements': [],
          'api_version': [1, 5, 0],
          'api_version_string': '1.5.0',
        };
      case 'server.config':
        return {
          'config': {
            'server': {'host': '0.0.0.0', 'port': 80, 'ssl_port': 443, 'klippy_uds_address': 'ffbridge', 'max_upload_size': 4096},
            'file_manager': {'enable_object_processing': false, 'queue_gcode_uploads': false, 'check_klipper_config_path': false},
            'history': {},
            'octoprint_compat': {},
            if (b.spoolman.configured) 'spoolman': {'server': b.spoolman.baseUrl, 'sync_rate': 5},
          },
          'orig': {},
          'files': [],
        };
      case 'server.restart':
      case 'printer.restart':
      case 'printer.firmware_restart':
        unawaited(b.reconnect());
        return 'ok';
      case 'printer.info':
        return {
          'state': b.online ? 'ready' : 'shutdown',
          'state_message': b.stateMessage,
          'hostname': b.cfg.name,
          'klipper_path': '/ffbridge',
          'python_path': '/ffbridge',
          'process_id': 1,
          'user_id': 1000,
          'group_id': 1000,
          'log_file': '/logs/ffbridge.log',
          'config_file': '/config/printer.cfg',
          'software_version': klipperVersion,
          'cpu_info': '${b.client.model} via FlashForge TV Bridge',
          'app': 'Klipper',
        };
      case 'printer.objects.list':
        return {'objects': b.builder.objectNames()};
      case 'printer.objects.query':
        return {'eventtime': b.eventtime, 'status': _query(Map<String, dynamic>.from(p['objects'] ?? {}))};
      case 'printer.objects.subscribe':
        final objs = Map<String, dynamic>.from(p['objects'] ?? {});
        if (c != null) {
          c.subs = {for (final e in objs.entries) e.key: e.value == null ? null : (e.value as List).map((x) => x.toString()).toList()};
        }
        return {'eventtime': b.eventtime, 'status': _query(objs)};
      case 'printer.query_endstops.status':
        return {'x': 'open', 'y': 'open', 'z': 'open'};
      case 'printer.gcode.script':
        final script = p['script']?.toString() ?? '';
        b.gcodeResponse(script, type: 'command');
        try {
          await gcode.runScript(script);
        } finally {
          Future.delayed(const Duration(milliseconds: 400), b.poll);
        }
        return 'ok';
      case 'printer.gcode.help':
        return GcodeRunner.commandsHelp(b).map((k, v) => MapEntry(k, v['help']));
      case 'printer.print.start':
        final fn = p['filename']?.toString() ?? '';
        List<MaterialMapping>? mappings;
        if (p['material_mappings'] is List) {
          mappings = [
            for (final m in p['material_mappings'] as List)
              MaterialMapping(m['toolId'] as int, m['slotId'] as int, m['materialName'].toString(), m['toolMaterialColor'].toString(), m['slotMaterialColor'].toString())
          ];
        }
        await b.startPrint(fn, mappings: mappings);
        return 'ok';
      case 'printer.print.pause':
        await gcode.runScript('PAUSE');
        return 'ok';
      case 'printer.print.resume':
        await gcode.runScript('RESUME');
        return 'ok';
      case 'printer.print.cancel':
        await gcode.runScript('CANCEL_PRINT');
        return 'ok';
      case 'printer.emergency_stop':
        await gcode.emergencyStop();
        return 'ok';
      case 'server.gcode_store':
        final count = int.tryParse('${p['count'] ?? 100}') ?? 100;
        final l = b.gcodeStore.toList();
        return {'gcode_store': l.length > count ? l.sublist(l.length - count) : l};
      case 'server.temperature_store':
        final includeMon = p['include_monitors'] == true || p['include_monitors'] == 'true';
        return {
          for (final e in b.tempStore.entries)
            e.key: {
              'temperatures': e.value.temps.toList(),
              'targets': e.value.targets.toList(),
              'powers': e.value.powers.toList(),
            },
          if (includeMon) ...{},
        };
      case 'server.logs.rollover':
        return {'rolled_over': [], 'failed': {}};
      // ---------------- machine ----------------
      case 'machine.system_info':
        return {'system_info': await _systemInfo()};
      case 'machine.proc_stats':
        final ps = _procStatUpdate();
        return {
          'moonraker_stats': [ps['moonraker_stats']],
          'throttled_state': {'bits': 0, 'flags': []},
          'cpu_temp': null,
          'network': {},
          'system_cpu_usage': ps['system_cpu_usage'],
          'system_memory': ps['system_memory'],
          'system_uptime': DateTime.now().difference(_start).inSeconds.toDouble(),
          'websocket_connections': _conns.length,
        };
      case 'machine.services.restart':
      case 'machine.services.start':
        unawaited(b.reconnect());
        return 'ok';
      case 'machine.services.stop':
      case 'machine.reboot':
      case 'machine.shutdown':
        throw RpcError(400, 'Not supported on the TV bridge');
      case 'machine.update.status':
        return {'busy': false, 'github_rate_limit': null, 'github_requests_remaining': null, 'github_limit_reset_time': null, 'version_info': {}};
      // ---------------- files ----------------
      case 'server.files.roots':
        return [for (final r in f.roots) {'name': r, 'path': '${f.dataDir}/$r', 'permissions': r == 'gcodes' ? 'rw' : 'r'}];
      case 'server.files.list':
        return f.listFiles(p['root']?.toString() ?? 'gcodes');
      case 'server.files.get_directory':
        return f.getDirectory(p['path']?.toString() ?? 'gcodes', extended: p['extended'] == true || p['extended'] == 'true');
      case 'server.files.metadata':
        final fn = p['filename']?.toString() ?? '';
        final m = f.metadataFor(fn);
        if (m == null) throw RpcError(404, 'Metadata not available for <$fn>');
        return m;
      case 'server.files.metascan':
        await f.scanMetadata(p['filename']?.toString() ?? '');
        return f.metadataFor(p['filename']?.toString() ?? '');
      case 'server.files.thumbnails':
        final m = f.metadataFor(p['filename']?.toString() ?? '');
        final fn = p['filename']?.toString() ?? '';
        final dir = fn.contains('/') ? fn.substring(0, fn.lastIndexOf('/') + 1) : '';
        return [
          for (final t in (m?['thumbnails'] as List? ?? []))
            {...Map<String, dynamic>.from(t as Map), 'thumbnail_path': '$dir${t['relative_path']}'}
        ];
      case 'server.files.post_directory':
        f.createDir(p['path'].toString());
        final (r, rel) = f.splitPath(p['path'].toString());
        _fileChanged('create_dir', r, rel);
        return {'item': {'path': rel, 'root': r}, 'action': 'create_dir'};
      case 'server.files.delete_directory':
        f.deleteDir(p['path'].toString(), force: p['force'] == true || p['force'] == 'true');
        final (r, rel) = f.splitPath(p['path'].toString());
        _fileChanged('delete_dir', r, rel);
        return {'item': {'path': rel, 'root': r}, 'action': 'delete_dir'};
      case 'server.files.delete_file':
        f.deleteFile(p['path'].toString());
        final (r, rel) = f.splitPath(p['path'].toString());
        _fileChanged('delete_file', r, rel);
        return {'item': {'path': rel, 'root': r}, 'action': 'delete_file'};
      case 'server.files.move':
      case 'server.files.copy':
        final copy = method.endsWith('copy');
        f.move(p['source'].toString(), p['dest'].toString(), copy: copy);
        final (r, rel) = f.splitPath(p['dest'].toString());
        final (_, srel) = f.splitPath(p['source'].toString());
        _fileChanged(copy ? 'create_file' : 'move_file', r, rel, sourcePath: srel);
        return {'item': {'path': rel, 'root': r}, 'action': copy ? 'create_file' : 'move_file'};
      // ---------------- database ----------------
      case 'server.database.list':
        return {'namespaces': b.db.namespaces, 'backups': []};
      case 'server.database.get_item':
        final ns = p['namespace'].toString();
        return {'namespace': ns, 'key': p['key'], 'value': b.db.getItem(ns, p['key'])};
      case 'server.database.post_item':
        final ns = p['namespace'].toString();
        var value = p['value'];
        if (value is String) {
          try {
            value = jsonDecode(value);
          } catch (_) {}
        }
        b.db.postItem(ns, p['key'], value);
        return {'namespace': ns, 'key': p['key'], 'value': value};
      case 'server.database.delete_item':
        final ns = p['namespace'].toString();
        return {'namespace': ns, 'key': p['key'], 'value': b.db.deleteItem(ns, p['key'])};
      case 'server.database.compact':
      case 'server.database.post_backup':
        return {};
      // ---------------- history ----------------
      case 'server.history.list':
        final l = b.history.list(
            limit: int.tryParse('${p['limit'] ?? 50}') ?? 50,
            start: int.tryParse('${p['start'] ?? 0}') ?? 0,
            since: double.tryParse('${p['since'] ?? 0}') ?? 0,
            before: double.tryParse('${p['before'] ?? 0}') ?? 0,
            order: p['order']?.toString() ?? 'desc');
        for (final j in (l['jobs'] as List)) {
          (j as Map)['exists'] = f.isLocal(j['filename']) || f.printerFiles.containsKey(j['filename']);
        }
        return l;
      case 'server.history.totals':
        return b.history.totals();
      case 'server.history.reset_totals':
        return {'last_totals': b.history.totals()['job_totals']};
      case 'server.history.get_job':
        final j = b.history.get(p['uid'].toString());
        if (j == null) throw RpcError(404, 'Job not found');
        return {'job': j};
      case 'server.history.delete_job':
        final all = p['all'] == true || p['all'] == 'true';
        final deleted = b.history.delete(uid: p['uid']?.toString(), all: all);
        b.emitRaw('notify_history_changed', [
          for (final id in deleted) {'action': 'deleted', 'job': {'job_id': id}}
        ]);
        return {'deleted_jobs': deleted};
      // ---------------- job queue (not used, but answered) ----------------
      case 'server.job_queue.status':
        return {'queued_jobs': [], 'queue_state': 'ready'};
      case 'server.job_queue.post_job':
      case 'server.job_queue.delete_job':
      case 'server.job_queue.pause':
      case 'server.job_queue.start':
      case 'server.job_queue.jump':
        return {'queued_jobs': [], 'queue_state': 'ready'};
      // ---------------- announcements ----------------
      case 'server.announcements.list':
        return {'entries': [], 'feeds': []};
      case 'server.announcements.update':
        return {'entries': [], 'modified': false};
      case 'server.announcements.dismiss':
      case 'server.announcements.feeds':
        return {'feeds': []};
      // ---------------- webcams ----------------
      case 'server.webcams.list':
        return {'webcams': _webcams()};
      case 'server.webcams.get_item':
        final w = _webcams().firstWhere((w) => w['name'] == p['name'] || w['uid'] == p['uid'], orElse: () => throw RpcError(404, 'Webcam not found'));
        return {'webcam': w};
      case 'server.webcams.post_item':
        final w = Map<String, dynamic>.from(p);
        final uid = (w['uid'] ?? 'cam-${DateTime.now().millisecondsSinceEpoch}').toString();
        w['uid'] = uid;
        w['source'] = 'database';
        b.db.postItem('webcams', uid, w);
        b.emitRaw('notify_webcams_changed', [
          {'webcams': _webcams()}
        ]);
        return {'webcam': w};
      case 'server.webcams.delete_item':
        final list = _webcams();
        final w = list.firstWhere((w) => w['name'] == p['name'] || w['uid'] == p['uid'], orElse: () => {});
        if (w.isEmpty) throw RpcError(404, 'Webcam not found');
        if (w['source'] == 'config') throw RpcError(400, 'The built-in camera cannot be deleted');
        b.db.deleteItem('webcams', w['uid']);
        b.emitRaw('notify_webcams_changed', [
          {'webcams': _webcams()}
        ]);
        return {'webcam': w};
      case 'server.webcams.test':
        return {'name': p['name'], 'snapshot_reachable': b.hasCamera};
      // ---------------- spoolman ----------------
      case 'server.spoolman.status':
        return {'spoolman_connected': await b.spoolman.ping(), 'pending_reports': [], 'spool_id': b.activeSpoolId};
      case 'server.spoolman.get_spool_id':
        return {'spool_id': b.activeSpoolId};
      case 'server.spoolman.post_spool_id':
        final id = p['spool_id'] == null ? null : int.tryParse(p['spool_id'].toString());
        b.activeSpoolId = id;
        return {'spool_id': id};
      case 'server.spoolman.proxy':
        if (!b.spoolman.configured) throw RpcError(503, 'Spoolman is not configured');
        final v2 = p['use_v2_response'] == true;
        try {
          final (code, body) = await b.spoolman.request(p['request_method']?.toString() ?? 'GET', p['path']?.toString() ?? '/v1/info',
              query: p['query'] is Map ? Map<String, dynamic>.from(p['query']) : null, body: p['body']);
          if (v2) {
            return code >= 400
                ? {'response': null, 'error': {'status_code': code, 'message': body is Map ? (body['message'] ?? '$body') : '$body'}}
                : {'response': body, 'response_headers': {}, 'error': null};
          }
          if (code >= 400) throw RpcError(code, '$body');
          return body;
        } catch (e) {
          if (e is RpcError) rethrow;
          if (v2) return {'response': null, 'error': {'status_code': 503, 'message': 'Spoolman unreachable: $e'}};
          throw RpcError(503, 'Spoolman unreachable: $e');
        }
      // ---------------- misc ----------------
      case 'server.sensors.list':
        return {'sensors': {}};
      case 'machine.device_power.devices':
        return {'devices': []};
      case 'server.extensions.list':
        return {'agents': []};
      case 'access.get_user':
        return {'username': '_TRUSTED_USER_', 'source': 'moonraker', 'created_on': 0.0};
      case 'access.users.list':
        return {'users': []};
      case 'access.api_key':
      case 'access.get_api_key':
        return 'ffbridge';
      case 'server.files.zip':
        throw RpcError(400, 'Not supported');
      // FlashForge-specific extras (used by the TV UI / power users)
      case 'ffbridge.status':
        return {
          'online': b.online,
          'model': b.client.model,
          'firmware': b.client.firmware,
          'detail': b.client.last?.raw,
          'slots': [for (final s in b.client.last?.slots ?? []) s.toJson()],
          'camera': {'url': b.cameraUrl(), 'active': b.camera.active, 'frames': b.camera.frames, 'error': b.camera.lastError},
        };
    }
    throw RpcError(404, 'Method not found: $method');
  }

  List<Map<String, dynamic>> _webcams() {
    final list = <Map<String, dynamic>>[];
    if (b.hasCamera) {
      list.add({
        'name': b.client.model.isEmpty ? 'Printer camera' : '${b.client.model} camera',
        'location': 'printer',
        'service': 'mjpegstreamer-adaptive',
        'enabled': true,
        'icon': 'mdiWebcam',
        'target_fps': 15,
        'target_fps_idle': 5,
        'stream_url': '/webcam/?action=stream',
        'snapshot_url': '/webcam/?action=snapshot',
        'flip_horizontal': false,
        'flip_vertical': false,
        'rotation': 0,
        'aspect_ratio': '4:3',
        'extra_data': {},
        'source': 'config',
        'uid': 'ffbridge-printer-camera',
      });
    }
    try {
      final extra = b.db.getItem('webcams', null);
      if (extra is Map) {
        for (final w in extra.values) {
          if (w is Map) list.add(Map<String, dynamic>.from(w));
        }
      }
    } catch (_) {}
    return list;
  }

  Future<Map<String, dynamic>> _systemInfo() async {
    final ifaces = <String, dynamic>{};
    try {
      for (final ni in await NetworkInterface.list(type: InternetAddressType.IPv4)) {
        ifaces[ni.name] = {
          'mac_address': '',
          'ip_addresses': [
            for (final a in ni.addresses) {'family': 'ipv4', 'address': a.address, 'is_link_local': false}
          ]
        };
      }
    } catch (_) {}
    return {
      'cpu_info': {
        'cpu_count': Platform.numberOfProcessors,
        'bits': '64bit',
        'processor': 'aarch64',
        'cpu_desc': 'Android TV',
        'serial_number': '',
        'hardware_desc': 'FlashForge TV Bridge',
        'model': Platform.operatingSystemVersion,
        'total_memory': 2048000,
        'memory_units': 'kB',
      },
      'sd_info': {},
      'distribution': {
        'name': 'Android (FlashForge TV Bridge)',
        'id': 'android',
        'version': Platform.operatingSystemVersion,
        'version_parts': {'major': '', 'minor': '', 'build_number': ''},
        'like': '',
        'codename': '',
      },
      'available_services': [],
      'instance_ids': {'moonraker': 'moonraker', 'klipper': 'klipper'},
      'service_state': {},
      'virtualization': {'virt_type': 'none', 'virt_identifier': 'none'},
      'python': {'version': [3, 11, 0, 'final', 0], 'version_string': '3.11.0'},
      'network': ifaces,
      'canbus': {},
    };
  }
}
