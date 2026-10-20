// FlashForge HTTP API client (Adventurer 5M / 5M Pro / AD5X / Creator 5 / Creator 5 Pro).
// Port of the relevant parts of @ghosttypes/ff-api to pure dart:io.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'models.dart';
import 'tcp_client.dart';

class FlashForgeException implements Exception {
  final String message;
  FlashForgeException(this.message);
  @override
  String toString() => message;
}

const _noChange = -200; // temperatureCtl_cmd "leave unchanged"
const _off = -100; // scalar heater off
const _nozzleOff = 0; // nozzle array "off"

class FlashForgeClient {
  final String ip;
  final String serial;
  final String checkCode;
  final int httpPort;
  final HttpClient _http = HttpClient()..connectionTimeout = const Duration(seconds: 5);

  bool httpOnly;
  bool isCreator5 = false, isCreator5Pro = false, isAD5X = false, isPro = false;
  String model = '', firmware = '', name = '';
  int nozzleCount = 1;
  final Capabilities caps = Capabilities();
  PrinterDetail? last;
  FlashForgeTcpClient? _tcp;
  Future<void> _queue = Future.value();

  FlashForgeClient(this.ip, this.serial, this.checkCode, {this.httpPort = 8898, this.httpOnly = false});

  String _url(String ep) => 'http://$ip:$httpPort$ep';
  Map<String, dynamic> get _auth => {'serialNumber': serial, 'checkCode': checkCode};

  Future<Map<String, dynamic>> _post(String ep, Map<String, dynamic> body, {Duration timeout = const Duration(seconds: 6)}) async {
    final req = await _http.postUrl(Uri.parse(_url(ep))).timeout(timeout);
    req.headers.contentType = ContentType.json;
    req.headers.set('Accept', '*/*');
    final bytes = utf8.encode(jsonEncode(body));
    req.contentLength = bytes.length;
    req.add(bytes);
    final res = await req.close().timeout(timeout);
    final text = await res.transform(utf8.decoder).join().timeout(timeout);
    if (res.statusCode != 200) throw FlashForgeException('HTTP ${res.statusCode} from $ep');
    final j = jsonDecode(text);
    if (j is! Map) throw FlashForgeException('Bad response from $ep');
    return Map<String, dynamic>.from(j);
  }

  static bool isOk(Map r) => r['code'] == 0 && (r['message'] == null || r['message'] == 'Success');

  /// Runs state-changing commands one at a time (the firmware handles one at a time).
  Future<T> _exclusive<T>(Future<T> Function() fn) {
    final c = Completer<T>();
    _queue = _queue.then((_) async {
      try {
        c.complete(await fn());
      } catch (e, st) {
        c.completeError(e, st);
      }
    });
    return c.future;
  }

  Future<PrinterDetail> detail() async {
    final r = await _post('/detail', _auth);
    if (!isOk(r) || r['detail'] is! Map) throw FlashForgeException('Detail request rejected: ${r['message'] ?? r['code']}');
    final d = PrinterDetail(Map<String, dynamic>.from(r['detail']));
    last = d;
    return d;
  }

  /// Verifies credentials and loads model/capabilities.
  Future<PrinterDetail> connect() async {
    final d = await detail();
    isCreator5 = d.isCreator5;
    isCreator5Pro = d.isCreator5Pro;
    isAD5X = d.isAD5X;
    isPro = d.isPro;
    model = d.model;
    name = d.name;
    firmware = d.firmwareVersion;
    nozzleCount = d.nozzleCount;
    if (isCreator5) httpOnly = true;
    final p = await _exclusive(() => _post('/product', _auth));
    if (!isOk(p)) throw FlashForgeException('Pairing rejected (check the pairing code): ${p['message'] ?? p['code']}');
    final prod = (p['product'] is Map) ? Map<String, dynamic>.from(p['product']) : <String, dynamic>{};
    caps.led = prod['lightCtrlState'] == 1;
    caps.filtration = prod['internalFanCtrlState'] == 1 && prod['externalFanCtrlState'] == 1;
    caps.chamber = prod['chamberTempCtrlState'] == 1;
    if (isCreator5Pro) caps.filtration = true;
    if (isCreator5) caps.chamber = true;
    if (!httpOnly) {
      _tcp = FlashForgeTcpClient(ip);
      try {
        await _tcp!.connect();
      } catch (_) {
        _tcp = null; // TCP is optional (only used for raw G-code / homing)
      }
    }
    return d;
  }

  bool get supportsGcode => !httpOnly && _tcp != null;

  Future<void> dispose() async {
    await _tcp?.close();
    _http.close(force: true);
  }

  Future<bool> sendControl(String cmd, Object? args) => _exclusive(() async {
        final r = await _post('/control', {
          ..._auth,
          'payload': {'cmd': cmd, 'args': args}
        });
        return isOk(r);
      });

  // ---------------- job control ----------------
  Future<bool> pause() => sendControl('jobCtl_cmd', {'jobID': '', 'action': 'pause'});
  Future<bool> resume() => sendControl('jobCtl_cmd', {'jobID': '', 'action': 'continue'});
  Future<bool> cancel() => sendControl('jobCtl_cmd', {'jobID': '', 'action': 'cancel'});
  Future<bool> clearPlatform() => sendControl('stateCtrl_cmd', {'action': 'setClearPlatform'});

  // ---------------- lights / filtration / camera ----------------
  Future<bool> setLed(bool on) async {
    final ok = await sendControl('lightControl_cmd', {'status': on ? 'open' : 'close'});
    if (ok) last?.raw['lightStatus'] = on ? 'open' : 'close';
    return ok;
  }
  Future<bool> setFiltration({required bool internal, required bool external}) async {
    final ok = await sendControl('circulateCtl_cmd', {'internal': internal ? 'open' : 'close', 'external': external ? 'open' : 'close'});
    if (ok) {
      last?.raw['internalFanStatus'] = internal ? 'open' : 'close';
      last?.raw['externalFanStatus'] = external ? 'open' : 'close';
    }
    return ok;
  }
  Future<bool> setCamera(bool on) => sendControl('streamCtrl_cmd', {'action': on ? 'open' : 'close'});

  /// printerCtl_cmd (only valid while printing). Unspecified values keep their current setting.
  Future<bool> printerControl({double? zOffset, int? speed, int? chamberFan, int? coolingFan}) async {
    final d = last ?? await detail();
    final args = {
      'zAxisCompensation': zOffset ?? d.zAxisCompensation,
      'speed': speed ?? d.printSpeedAdjust,
      'chamberFan': chamberFan ?? d.chamberFanSpeed.round(),
      'coolingFan': coolingFan ?? d.coolingFanSpeed.round(),
      'coolingLeftFan': 0,
    };
    final ok = await sendControl('printerCtl_cmd', args);
    if (ok) {
      // optimistic cache update so consecutive adjustments build on each other
      d.raw['zAxisCompensation'] = args['zAxisCompensation'];
      d.raw['printSpeedAdjust'] = args['speed'];
      d.raw['chamberFanSpeed'] = args['chamberFan'];
      d.raw['coolingFanSpeed'] = args['coolingFan'];
    }
    return ok;
  }

  // ---------------- temperatures ----------------
  Future<bool> _tempCmd({num? right, num? platform, num? chamber, List<num>? nozzles}) {
    final args = <String, dynamic>{
      'rightNozzle': right ?? _noChange,
      'leftNozzle': _noChange,
      'platform': platform ?? _noChange,
      'chamber': chamber ?? _noChange,
    };
    if (nozzles != null) {
      args['nozzles'] = nozzles;
    } else if (isCreator5) {
      args['nozzles'] = List<num>.filled(4, _noChange);
    }
    return sendControl('temperatureCtl_cmd', args);
  }

  /// Set a tool (0-based) temperature. 0 turns it off.
  Future<bool> setToolTemp(int tool, num temp) async {
    if (isCreator5) {
      final n = List<num>.filled(4, _noChange);
      if (tool < 0 || tool > 3) throw FlashForgeException('Tool $tool out of range');
      n[tool] = temp <= 0 ? _nozzleOff : temp.round();
      return _tempCmd(nozzles: n);
    }
    if (supportsGcode) return (await _tcp!.gcode(temp <= 0 ? 'M104 S0' : 'M104 S${temp.round()}')) != null;
    return _tempCmd(right: temp <= 0 ? _off : temp.round());
  }

  Future<bool> setBedTemp(num temp) async {
    if (!httpOnly && supportsGcode) return (await _tcp!.gcode('M140 S${temp <= 0 ? 0 : temp.round()}')) != null;
    return _tempCmd(platform: temp <= 0 ? _off : temp.round());
  }

  Future<bool> setChamberTemp(num temp) => _tempCmd(chamber: temp <= 0 ? _off : (temp > 80 ? 80 : temp.round()));

  // ---------------- material station ----------------
  Future<bool> configureSlot(int slot, String material, String hex) {
    final rgb = snapToPalette(hex, creator5: isCreator5)[1];
    return sendControl('msConfig_cmd', {'slot': slot, 'mt': material, 'rgb': rgb});
  }

  /// AD5X only: 0=load 1=unload 2=cancel
  Future<bool> slotAction(int slot, int action) => sendControl('ms_cmd', {'slot': slot, 'action': action});

  // ---------------- files ----------------
  Future<List<FileEntry>> recentFiles() async {
    final r = await _post('/gcodeList', _auth);
    if (!isOk(r)) return [];
    final det = r['gcodeListDetail'];
    if (det is List && det.isNotEmpty) {
      return [
        for (final e in det)
          if (e is Map)
            FileEntry(e['gcodeFileName']?.toString() ?? '',
                printingTime: (e['printingTime'] as num?)?.toInt() ?? 0,
                totalFilamentWeight: (e['totalFilamentWeight'] as num?)?.toDouble() ?? 0,
                toolDatas: [for (final t in (e['gcodeToolDatas'] as List? ?? const [])) Map<String, dynamic>.from(t as Map)])
      ];
    }
    final l = r['gcodeList'];
    if (l is List) {
      return [
        for (final e in l)
          if (e is String) FileEntry(e) else if (e is Map) FileEntry(e['gcodeFileName']?.toString() ?? '', printingTime: (e['printingTime'] as num?)?.toInt() ?? 0)
      ];
    }
    return [];
  }

  Future<List<int>?> thumbnail(String fileName) async {
    try {
      final r = await _post('/gcodeThumb', {..._auth, 'fileName': fileName}, timeout: const Duration(seconds: 10));
      if (!isOk(r) || r['imageData'] == null) return null;
      return base64.decode(r['imageData'].toString());
    } catch (_) {
      return null;
    }
  }

  /// Starts a print of a file already stored on the printer.
  Future<bool> printLocal(String fileName, {bool leveling = false, List<MaterialMapping>? mappings}) => _exclusive(() async {
        Map<String, dynamic> body;
        if (isCreator5) {
          body = {..._auth, 'fileName': fileName, 'levelingBeforePrint': leveling, 'flowCalibration': false, 'timeLapseVideo': false};
          if (mappings != null && mappings.isNotEmpty) body['materialMappings'] = [for (final m in mappings) m.toJson()];
        } else if (isAD5X) {
          final use = mappings != null && mappings.isNotEmpty;
          body = {
            ..._auth,
            'fileName': fileName,
            'levelingBeforePrint': leveling,
            'firstLayerInspection': false,
            'flowCalibration': false,
            'timeLapseVideo': false,
            'useMatlStation': use,
            'gcodeToolCnt': use ? mappings.length : 0,
            'materialMappings': use ? [for (final m in mappings) m.toJson()] : [],
          };
        } else {
          body = {
            ..._auth,
            'fileName': fileName,
            'levelingBeforePrint': leveling,
            'flowCalibration': false,
            'useMatlStation': false,
            'gcodeToolCnt': 0,
            'materialMappings': [],
          };
        }
        final r = await _post('/printGcode', body);
        if (!isOk(r)) throw FlashForgeException('Printer refused to start: ${r['message'] ?? r['code']}');
        return true;
      });

  /// Uploads a file with a raw socket so Expect: 100-continue is honoured exactly like
  /// FlashForge's own clients. [onProgress] receives bytes sent.
  Future<void> upload(File file, String fileName,
      {bool printNow = false,
      bool leveling = false,
      int toolCount = 0,
      List<MaterialMapping>? mappings,
      void Function(int sent, int total)? onProgress}) async {
    final size = await file.length();
    final boundary = '----ffbridge${DateTime.now().microsecondsSinceEpoch}';
    final safeName = fileName.replaceAll('"', '');
    final pre = utf8.encode('--$boundary\r\nContent-Disposition: form-data; name="gcodeFile"; filename="$safeName"\r\n'
        'Content-Type: application/octet-stream\r\n\r\n');
    final post = utf8.encode('\r\n--$boundary--\r\n');
    final headers = <String, String>{
      'Host': '$ip:$httpPort',
      'serialNumber': serial,
      'checkCode': checkCode,
      'fileSize': '$size',
      'printNow': '$printNow',
      'levelingBeforePrint': '$leveling',
      'Content-Type': 'multipart/form-data; boundary=$boundary',
      'Content-Length': '${pre.length + size + post.length}',
      'Expect': '100-continue',
      'Accept': '*/*',
      'Connection': 'close',
    };
    final useMappings = printNow && mappings != null && mappings.isNotEmpty;
    final mapB64 = base64.encode(utf8.encode(jsonEncode(useMappings ? [for (final m in mappings) m.toJson()] : [])));
    if (isCreator5) {
      headers.addAll({
        'flowCalibration': 'false',
        'timeLapseVideo': 'false',
        'useMatlStation': '${toolCount > 1}',
        'gcodeToolCnt': '$toolCount',
      });
      if (useMappings) headers['materialMappings'] = mapB64;
    } else if (isAD5X) {
      headers.addAll({
        'flowCalibration': 'false',
        'firstLayerInspection': 'false',
        'timeLapseVideo': 'false',
        'useMatlStation': '$useMappings',
        'gcodeToolCnt': useMappings ? '${mappings.length}' : '0',
        'materialMappings': mapB64,
      });
    } else {
      headers.addAll({'flowCalibration': 'false', 'useMatlStation': 'false', 'gcodeToolCnt': '0', 'materialMappings': 'W10='});
    }

    final sock = await Socket.connect(ip, httpPort, timeout: const Duration(seconds: 8));
    final resp = BytesBuilder();
    final gotData = Completer<void>();
    final done = Completer<void>();
    sock.listen((d) {
      resp.add(d);
      if (!gotData.isCompleted) gotData.complete();
    }, onDone: () {
      if (!gotData.isCompleted) gotData.complete();
      if (!done.isCompleted) done.complete();
    }, onError: (e) {
      if (!done.isCompleted) done.completeError(e);
    }, cancelOnError: true);
    try {
      final sb = StringBuffer('POST /uploadGcode HTTP/1.1\r\n');
      headers.forEach((k, v) => sb.write('$k: $v\r\n'));
      sb.write('\r\n');
      sock.add(utf8.encode(sb.toString()));
      await sock.flush();
      // Wait briefly for "100 Continue" (proceed anyway after 2 s, like curl).
      await gotData.future.timeout(const Duration(seconds: 2), onTimeout: () {});
      final early = utf8.decode(resp.toBytes(), allowMalformed: true);
      if (early.startsWith('HTTP/1.1 4') || early.startsWith('HTTP/1.1 5')) {
        throw FlashForgeException('Upload rejected: ${early.split('\r\n').first}');
      }
      resp.clear();
      sock.add(pre);
      var sent = 0;
      await for (final chunk in file.openRead()) {
        sock.add(chunk);
        sent += chunk.length;
        onProgress?.call(sent, size);
        await sock.flush();
      }
      sock.add(post);
      await sock.flush();
      await done.future.timeout(const Duration(minutes: 3), onTimeout: () {});
    } finally {
      sock.destroy();
    }
    var text = utf8.decode(resp.toBytes(), allowMalformed: true);
    // strip any interim 100 response
    while (text.startsWith('HTTP/1.1 100')) {
      final i = text.indexOf('\r\n\r\n');
      if (i < 0) break;
      text = text.substring(i + 4);
    }
    final bodyIdx = text.indexOf('\r\n\r\n');
    final status = text.split('\r\n').first;
    if (!status.contains(' 200')) throw FlashForgeException('Upload failed: $status');
    var body = bodyIdx >= 0 ? text.substring(bodyIdx + 4).trim() : '';
    if (text.toLowerCase().contains('transfer-encoding: chunked')) body = _dechunk(body);
    try {
      final j = jsonDecode(body.substring(body.indexOf('{')));
      if (j is Map && !isOk(j)) throw FlashForgeException('Upload rejected: ${j['message'] ?? j['code']}');
    } on FormatException {
      // non-JSON body with 200: treat as success
    }
  }

  static String _dechunk(String s) {
    final out = StringBuffer();
    var rest = s;
    while (rest.isNotEmpty) {
      final nl = rest.indexOf('\r\n');
      if (nl < 0) break;
      final len = int.tryParse(rest.substring(0, nl).trim(), radix: 16) ?? 0;
      if (len == 0) break;
      out.write(rest.substring(nl + 2, (nl + 2 + len).clamp(0, rest.length)));
      rest = rest.length > nl + 4 + len ? rest.substring(nl + 4 + len) : '';
    }
    return out.toString();
  }

  // ---------------- raw G-code (TCP printers only) ----------------
  Future<String?> gcode(String line) async {
    if (!supportsGcode) return null;
    return _tcp!.gcode(line);
  }
}
