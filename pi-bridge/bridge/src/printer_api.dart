// JSON API behind the printer screen (camera-first home view, print dialog, filament slots).
// Everything here talks to the printer through the same PrinterBridge the Moonraker
// emulation uses, so Mainsail / OrcaSlicer and this page always agree.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'core.dart';

typedef JsonReply = Future<void> Function(HttpRequest req, Object? body, {int status});

class PrinterApi {
  final BridgeHost host;
  PrinterApi(this.host);

  PrinterBridge? bridge(String id) => host.instances[id]?.bridge;

  // ------------------------------------------------------------------ state for the home view
  /// Extra live fields for one printer (merged into the setup server's printer JSON).
  Map<String, dynamic> liveJson(PrinterBridge? b) {
    final d = b?.client.last;
    if (b == null || d == null) return {'slots': [], 'pending': null};
    final c = b.client;
    return {
      'model': d.model,
      'kind': c.isCreator5 ? 'creator5' : (c.isAD5X ? 'ad5x' : (c.isPro ? '5mpro' : '5m')),
      'machineState': d.status,
      'light': d.lightsOn,
      'filtrationInternal': d.internalFanOn,
      'filtrationExternal': d.externalFanOn,
      'hasFiltration': c.isCreator5 || c.isPro,
      'door': d.doorOpen,
      'speed': d.printSpeedAdjust,
      'zOffset': d.zAxisCompensation,
      'coolingFan': d.coolingFanSpeed,
      'chamberFan': d.chamberFanSpeed,
      'errorCode': d.errorCode,
      'error': b.currentError?.toJson(),
      'filamentWeight': d.estimatedRightWeight,
      'jobThumb': b.jobFile.isEmpty ? '' : thumbUrl(b, b.jobFile),
      'slots': [
        for (final s in d.slots)
          {'slotId': s.slotId, 'hasFilament': s.hasFilament, 'material': s.materialName, 'color': _hex(s.materialColor), 'colorName': colorName(_hex(s.materialColor))}
      ],
      'currentSlot': d.currentSlot,
      'slotPalette': c.isCreator5 ? creator5Palette : ad5xPalette,
      'materials': materialNames,
      'pending': b.pendingMapping == null ? null : {'file': b.pendingMapping!.file, ...planJson(b.pendingMapping!)},
    };
  }

  static String _hex(String c) {
    final n = normalizeColor(c);
    return n.isEmpty ? '#FFFFFF' : n;
  }

  String thumbUrl(PrinterBridge b, String file) => '/api/printers/${b.cfg.id}/thumb?file=${Uri.encodeQueryComponent(file)}';

  Map<String, dynamic> planJson(MappingPlan p) => {
        'confident': p.confident,
        'lines': [
          for (final l in p.lines)
            {
              'filament': l.filament.index,
              'type': l.filament.type,
              'color': l.filament.color,
              'colorName': colorName(l.filament.color),
              'slot': l.slot.slotId,
              'verdict': l.verdict,
              'good': l.good,
              'colorDiff': double.parse(l.colorDiff.toStringAsFixed(1)),
              'materialScore': l.materialScore,
            }
        ],
        'slots': [
          for (final s in p.slots) {'slotId': s.slotId, 'material': s.material, 'color': s.color, 'colorName': colorName(s.color)}
        ],
      };

  // ------------------------------------------------------------------ routing
  /// Handles /api/printers/<id>/<action>; returns false when the route isn't ours.
  Future<bool> handle(HttpRequest req, List<String> seg, JsonReply json) async {
    if (seg.length != 3 || seg[0] != 'printers') return false;
    final b = bridge(seg[1]);
    final action = seg[2], m = req.method;
    const mine = {'option', 'files', 'thumb', 'plan', 'print', 'upload', 'control', 'slot', 'pending', 'delete-file'};
    if (!mine.contains(action)) return false;
    if (b == null) {
      await json(req, {'ok': false, 'message': 'This printer is not running (check Advanced settings).'}, status: 404);
      return true;
    }
    switch ('$m $action') {
      case 'POST option':
        // Small per-printer switches that don't need a reconnect.
        final body = await _body(req);
        if (body['autoClearPlatform'] is bool) b.cfg.autoClearPlatform = body['autoClearPlatform'];
        if (body['levelBeforePrint'] is bool) b.cfg.levelBeforePrint = body['levelBeforePrint'];
        host.config.save();
        await json(req, {'ok': true, 'autoClearPlatform': b.cfg.autoClearPlatform, 'levelBeforePrint': b.cfg.levelBeforePrint});
      case 'GET files':
        await json(req, {'files': fileList(b)});
      case 'GET thumb':
        await _thumb(req, b, req.uri.queryParameters['file'] ?? '');
      case 'POST plan':
        final body = await _body(req);
        final p = b.smartMapping(b.files.resolve((body['file'] ?? '').toString()));
        await json(req, {'ok': true, 'plan': p == null ? null : planJson(p)});
      case 'POST print':
        await json(req, await _print(b, await _body(req)));
      case 'POST pending':
        await json(req, await _pending(b, await _body(req)));
      case 'POST upload':
        await json(req, await _upload(req, b));
      case 'POST control':
        await json(req, await control(b, await _body(req)));
      case 'POST slot':
        await json(req, await _slot(b, await _body(req)));
      case 'POST delete-file':
        final body = await _body(req);
        try {
          b.files.deleteFile('gcodes/${(body['file'] ?? '').toString()}');
          await json(req, {'ok': true});
        } on RpcError catch (e) {
          await json(req, {'ok': false, 'message': e.message});
        }
      default:
        await json(req, {'ok': false, 'message': 'Not supported'}, status: 405);
    }
    return true;
  }

  Future<Map<String, dynamic>> _body(HttpRequest req) async {
    final s = await utf8.decodeStream(req);
    if (s.trim().isEmpty) return {};
    final j = jsonDecode(s);
    return j is Map<String, dynamic> ? j : {};
  }

  // ------------------------------------------------------------------ files
  List<Map<String, dynamic>> fileList(PrinterBridge b) {
    final out = <Map<String, dynamic>>[];
    for (final e in b.files.listFiles('gcodes')) {
      final display = e['path'] as String;
      final real = b.files.resolve(display);
      final meta = b.files.metadataFor(real) ?? {};
      final fils = (meta['mmu_filaments'] as List?) ?? const [];
      out.add({
        'file': real,
        'name': _pretty(real.split('/').last),
        'modified': e['modified'],
        'size': e['size'],
        'local': b.files.isLocal(real),
        'onPrinter': b.files.printerFiles.containsKey(real.split('/').last),
        'estimatedTime': meta['estimated_time'],
        'filamentType': meta['filament_type'],
        'filamentWeight': meta['filament_weight_total'] ?? meta['filament_total'],
        'filaments': [
          for (final f in fils) {'type': (f as Map)['type'], 'color': _hex((f['color'] ?? '').toString())}
        ],
        'thumb': (meta['thumbnails'] is List && (meta['thumbnails'] as List).isNotEmpty) ? thumbUrl(b, real) : '',
      });
    }
    out.sort((a, b) => ((b['modified'] as num?) ?? 0).compareTo((a['modified'] as num?) ?? 0));
    return out;
  }

  /// "Benchy_PLA_1h5m.gcode.3mf" -> "Benchy_PLA_1h5m"
  static String _pretty(String n) => n.replaceAll(RegExp(r'(\.gcode\.3mf|\.3mf|\.gcode|\.g|\.gco)$', caseSensitive: false), '');

  Future<void> _thumb(HttpRequest req, PrinterBridge b, String file) async {
    final real = b.files.resolve(file);
    final meta = b.files.metadataFor(real) ?? {};
    final thumbs = (meta['thumbnails'] as List?) ?? const [];
    File? f;
    if (thumbs.isNotEmpty) {
      final best = thumbs.cast<Map>().reduce((x, y) => ((x['width'] as num?) ?? 0) >= ((y['width'] as num?) ?? 0) ? x : y);
      final dir = real.contains('/') ? '${real.substring(0, real.lastIndexOf('/'))}/' : '';
      final cand = File('${b.files.gcodes.path}/$dir${best['relative_path']}');
      if (cand.existsSync()) f = cand;
    }
    if (f == null) {
      req.response.statusCode = 404;
      return req.response.close();
    }
    req.response.headers
      ..contentType = ContentType('image', 'png')
      ..set('Cache-Control', 'public, max-age=600');
    await req.response.addStream(f.openRead());
    await req.response.close();
  }

  Future<Map<String, dynamic>> _upload(HttpRequest req, PrinterBridge b) async {
    final boundary = req.headers.contentType?.parameters['boundary'];
    if (boundary == null) return {'ok': false, 'message': 'Expected a file upload.'};
    final tmp = File('${b.dataDir}/upload_${DateTime.now().microsecondsSinceEpoch}.tmp');
    final mp = await parseMultipart(req, boundary, tmp);
    if (mp.file == null) return {'ok': false, 'message': 'No file received.'};
    final name = (mp.fileName ?? 'upload.gcode').split('/').last.split('\\').last;
    final lower = name.toLowerCase();
    if (!(lower.endsWith('.gcode') || lower.endsWith('.3mf') || lower.endsWith('.g') || lower.endsWith('.gco'))) {
      if (tmp.existsSync()) tmp.deleteSync();
      return {'ok': false, 'message': 'Only sliced files can be printed (.gcode or .gcode.3mf from OrcaSlicer / FlashPrint).'};
    }
    final dest = b.files.fileFor('gcodes', name);
    if (dest.existsSync()) dest.deleteSync();
    tmp.renameSync(dest.path);
    await b.files.scanMetadata(name);
    b.emitRaw('notify_filelist_changed', [
      {'action': 'create_file', 'item': {...b.files.itemInfo('gcodes', name), 'root': 'gcodes', 'path': name}}
    ]);
    b.gcodeResponse('// Received $name from the printer screen (${(mp.fileSize / 1024 / 1024).toStringAsFixed(1)} MB)');
    return {'ok': true, 'file': name};
  }

  // ------------------------------------------------------------------ printing
  /// Runs [job] but answers after a few seconds at the latest: sending a big file to the
  /// printer can take a while, and the page shows the progress from the status anyway.
  Future<Map<String, dynamic>> _soon(Future<void> Function() job, String okMessage) async {
    final c = Completer<Map<String, dynamic>>();
    job().then((_) {
      if (!c.isCompleted) c.complete({'ok': true, 'message': okMessage});
    }).catchError((Object e) {
      final msg = e is RpcError ? e.message : e.toString();
      if (!c.isCompleted) c.complete({'ok': false, 'message': msg});
    });
    return c.future.timeout(const Duration(seconds: 4), onTimeout: () => {'ok': true, 'message': 'Sending the file to the printer…'});
  }

  Future<Map<String, dynamic>> _print(PrinterBridge b, Map<String, dynamic> body) async {
    final file = b.files.resolve((body['file'] ?? '').toString());
    if (file.isEmpty) return {'ok': false, 'message': 'Pick a file first.'};
    if (!b.online) return {'ok': false, 'message': 'The printer is offline.'};
    if (b.jobState == 'printing' || b.jobState == 'paused') return {'ok': false, 'message': 'The printer is busy with another print.'};
    List<MaterialMapping>? mappings;
    final plan = b.smartMapping(file);
    if (plan != null) {
      final chosen = body['slots'];
      if (chosen is Map) {
        try {
          chosen.forEach((k, v) => plan.setSlot(int.parse(k.toString()), (v as num).toInt()));
        } on ArgumentError catch (e) {
          return {'ok': false, 'message': e.message.toString()};
        }
      }
      mappings = plan.toMappings();
    }
    final level = body['level'];
    return _soon(() async {
      final old = b.cfg.levelBeforePrint;
      if (level is bool) b.cfg.levelBeforePrint = level;
      try {
        // An empty list would mean "single colour" to startPrint; null lets it decide.
        await b.startPrint(file, mappings: mappings);
      } finally {
        b.cfg.levelBeforePrint = old;
      }
    }, 'Print started.');
  }

  Future<Map<String, dynamic>> _pending(PrinterBridge b, Map<String, dynamic> body) async {
    if (b.pendingMapping == null) return {'ok': false, 'message': 'No print is waiting.'};
    if (body['action'] == 'cancel') {
      b.cancelPendingPrint();
      return {'ok': true, 'message': 'Print cancelled.'};
    }
    final chosen = body['slots'];
    if (chosen is Map) {
      try {
        chosen.forEach((k, v) => b.setPendingSlot(int.parse(k.toString()) + 1, (v as num).toInt()));
      } on RpcError catch (e) {
        return {'ok': false, 'message': e.message};
      }
    }
    return _soon(b.confirmPendingPrint, 'Print started.');
  }

  // ------------------------------------------------------------------ controls
  Future<Map<String, dynamic>> control(PrinterBridge b, Map<String, dynamic> body) async {
    if (!b.online) return {'ok': false, 'message': 'The printer is offline.'};
    final c = b.client;
    final a = (body['action'] ?? '').toString();
    num n(String k) => (body[k] is num) ? body[k] as num : num.tryParse('${body[k]}') ?? 0;
    final printing = b.jobState == 'printing' || b.jobState == 'paused';
    bool ok;
    switch (a) {
      case 'pause':
        ok = await c.pause();
      case 'resume':
        ok = await c.resume();
      case 'cancel':
        ok = await c.cancel();
      case 'clear':
        ok = await c.clearPlatform();
      case 'light':
        ok = await c.setLed(body['on'] == true);
      case 'filtration':
        final d = c.last;
        ok = await c.setFiltration(
            internal: body['internal'] is bool ? body['internal'] : (d?.internalFanOn ?? false),
            external: body['external'] is bool ? body['external'] : (d?.externalFanOn ?? false));
      case 'temp':
        final t = (body['target'] ?? '').toString(), v = n('value');
        if (v < 0 || v > 350) return {'ok': false, 'message': 'Temperature out of range.'};
        if (t == 'bed') {
          ok = await c.setBedTemp(v);
        } else if (t == 'chamber') {
          ok = await c.setChamberTemp(v);
        } else if (t.startsWith('tool')) {
          ok = await c.setToolTemp(int.tryParse(t.substring(4)) ?? 0, v);
        } else {
          return {'ok': false, 'message': 'Unknown heater.'};
        }
      case 'speed':
      case 'zoffset':
      case 'fans':
        if (!printing) return {'ok': false, 'message': 'This can only be changed while printing.'};
        ok = await c.printerControl(
          speed: a == 'speed' ? n('value').round().clamp(10, 200) : null,
          zOffset: a == 'zoffset' ? n('value').toDouble().clamp(-1.0, 1.0) : null,
          coolingFan: a == 'fans' && body['cooling'] != null ? n('cooling').round().clamp(0, 100) : null,
          chamberFan: a == 'fans' && body['chamber'] != null ? n('chamber').round().clamp(0, 100) : null,
        );
      default:
        return {'ok': false, 'message': 'Unknown action "$a".'};
    }
    if (ok) b.gcodeResponse('// Printer screen: $a ${body.entries.where((e) => e.key != 'action').map((e) => '${e.key}=${e.value}').join(' ')}'.trim());
    unawaited(Future.delayed(const Duration(milliseconds: 600), b.poll));
    return {'ok': ok, 'message': ok ? 'Done.' : 'The printer did not accept that.'};
  }

  Future<Map<String, dynamic>> _slot(PrinterBridge b, Map<String, dynamic> body) async {
    final slot = (body['slot'] as num?)?.toInt() ?? 0;
    if (slot < 1 || slot > 4) return {'ok': false, 'message': 'Pick a slot 1-4.'};
    final c = b.client;
    bool ok;
    if (body['op'] == 'load' || body['op'] == 'unload') {
      if (!c.isAD5X) return {'ok': false, 'message': 'Load/unload from here only works on the AD5X.'};
      ok = await c.slotAction(slot, body['op'] == 'load' ? 0 : 1);
    } else {
      final material = (body['material'] ?? '').toString().trim();
      final color = normalizeColor((body['color'] ?? '').toString());
      if (material.isEmpty || color.isEmpty) return {'ok': false, 'message': 'Pick a material and a colour.'};
      ok = await c.configureSlot(slot, material, color);
    }
    unawaited(Future.delayed(const Duration(milliseconds: 600), b.poll));
    return {'ok': ok, 'message': ok ? 'Slot $slot updated.' : 'The printer did not accept that.'};
  }
}
