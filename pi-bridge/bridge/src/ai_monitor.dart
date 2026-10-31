// AI print failure detection.
//
// Every few seconds while a printer is printing, a camera frame is sent to the local
// inference service (ai/ffai_server.py, Obico's open-source failure model running on
// ONNX Runtime). The raw per-frame scores are smoothed with the same algorithm and
// hyper-parameters Obico uses (backend/lib/prediction.py, FD_1ST_GEN_PARAMS), so a single
// odd frame never triggers an alert:
//
//   p            = sum of detection confidences in the frame
//   ewm_mean     = exponentially weighted mean of p (span 12)
//   rolling_short/long = slow rolling means used as a per-printer baseline
//   failing      = (ewm - long) * sensitivity  above a threshold
//
// A "warning" notifies (Mainsail console popup + Discord + setup page). If the user chose
// "pause", a stronger signal (threshold / 1.75, Obico's escalation factor) pauses the print.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'core.dart';
import 'pi_config.dart';

/// Obico 1st-gen hyper-parameters (obico-server backend/config/settings.py).
class FdParams {
  static const ewmSpan = 12;
  static const rollingWinShort = 310;
  static const rollingWinLong = 7200;
  static const thresholdLow = 0.38;
  static const thresholdHigh = 0.78;
  static const initSafeFrameNum = 30;
  static const rollingMeanShortMultiple = 3.8;
  static const escalatingFactor = 1.75;
  static const visualizationThresh = 0.2;
}

class FailurePrediction {
  double currentP = 0;
  int currentFrameNum = 0;
  int lifetimeFrameNum = 0;
  double ewmMean = 0;
  double rollingMeanShort = 0;
  double rollingMeanLong = 0;

  void resetForNewPrint() {
    currentP = 0;
    currentFrameNum = 0;
    ewmMean = 0;
    rollingMeanShort = 0;
  }

  void update(List<Detection> detections) {
    final p = detections.fold<double>(0, (s, d) => s + d.confidence);
    const alpha = 2 / (FdParams.ewmSpan + 1);
    currentP = p;
    currentFrameNum++;
    lifetimeFrameNum++;
    ewmMean = p * alpha + ewmMean * (1 - alpha);
    rollingMeanShort = _rolling(p, rollingMeanShort, currentFrameNum, FdParams.rollingWinShort);
    rollingMeanLong = _rolling(p, rollingMeanLong, lifetimeFrameNum, FdParams.rollingWinLong);
  }

  static double _rolling(double p, double mean, int count, int win) => mean + (p - mean) / (win <= count ? win : count + 1);

  /// Obico's is_failing().
  bool isFailing(double sensitivity, {double escalatingFactor = 1}) {
    if (currentFrameNum < FdParams.initSafeFrameNum) return false;
    final adjusted = (ewmMean - rollingMeanLong) * sensitivity / escalatingFactor;
    if (adjusted < FdParams.thresholdLow) return false;
    if (adjusted > FdParams.thresholdHigh) return true;
    return adjusted > (rollingMeanShort - rollingMeanLong) * FdParams.rollingMeanShortMultiple;
  }

  /// 0..100 "how worried are we" value for the UI (100 = at the warning threshold or above).
  double get riskPercent {
    final adjusted = ewmMean - rollingMeanLong;
    return (adjusted / FdParams.thresholdHigh * 100).clamp(0, 100).toDouble();
  }

  Map<String, dynamic> toJson() => {
        'lifetimeFrameNum': lifetimeFrameNum,
        'rollingMeanLong': rollingMeanLong,
      };

  void loadLongTerm(Map<String, dynamic> j) {
    lifetimeFrameNum = (j['lifetimeFrameNum'] as num?)?.toInt() ?? 0;
    rollingMeanLong = (j['rollingMeanLong'] as num?)?.toDouble() ?? 0;
  }
}

class Detection {
  final String label;
  final double confidence;
  final double xc, yc, w, h; // pixels in the analysed image
  Detection(this.label, this.confidence, this.xc, this.yc, this.w, this.h);

  static Detection? fromJson(dynamic j) {
    try {
      final l = j as List;
      final box = l[2] as List;
      return Detection(l[0].toString(), (l[1] as num).toDouble(), (box[0] as num).toDouble(), (box[1] as num).toDouble(),
          (box[2] as num).toDouble(), (box[3] as num).toDouble());
    } catch (_) {
      return null;
    }
  }

  Map<String, dynamic> toJson() => {'label': label, 'confidence': confidence, 'xc': xc, 'yc': yc, 'w': w, 'h': h};
}

/// Per-printer detection state shown on the setup page.
class PrinterAiState {
  final String printerId;
  final FailurePrediction prediction = FailurePrediction();
  String status = 'idle'; // off | idle | watching | warning | paused | ignored | no-camera | ai-offline
  String message = '';
  String jobFile = '';
  bool warned = false, pausedByAi = false, ignored = false;
  DateTime? lastCheck;
  int lastInferenceMs = 0;
  Uint8List? lastImage;
  int imageWidth = 0, imageHeight = 0;
  List<Detection> lastDetections = [];
  final history = <double>[]; // recent ewm values for a sparkline
  DateTime nextDue = DateTime.fromMillisecondsSinceEpoch(0);
  bool busy = false;
  String lastJobState = 'standby';

  PrinterAiState(this.printerId);

  Map<String, dynamic> toJson() => {
        'status': status,
        'message': message,
        'jobFile': jobFile,
        'risk': const ['watching', 'warning', 'paused', 'ignored'].contains(status) ? prediction.riskPercent : 0.0,
        'p': prediction.currentP,
        'ewm': prediction.ewmMean,
        'frames': prediction.currentFrameNum,
        'warmupFrames': FdParams.initSafeFrameNum,
        'warned': warned,
        'pausedByAi': pausedByAi,
        'ignored': ignored,
        'lastCheck': lastCheck?.toIso8601String(),
        'inferenceMs': lastInferenceMs,
        'hasImage': lastImage != null,
        'imageWidth': imageWidth,
        'imageHeight': imageHeight,
        'detections': [for (final d in lastDetections) if (d.confidence >= FdParams.visualizationThresh) d.toJson()],
        'history': history,
      };
}

/// Health of the local inference service.
class AiServiceInfo {
  bool reachable = false;
  bool ready = false;
  bool pausedForSlicer = false;
  String model = '';
  String backend = '';
  String error = '';
  double avgMs = 0;
  DateTime? checkedAt;

  Map<String, dynamic> toJson() => {
        'reachable': reachable,
        'ready': ready,
        'pausedForSlicer': pausedForSlicer,
        'model': model,
        'backend': backend,
        'error': error,
        'avgMs': avgMs,
        'checkedAt': checkedAt?.toIso8601String(),
      };
}

class AiMonitor {
  final BridgeHost host;
  final PiConfig pi;
  final Uri serviceUrl;
  final Log log;
  final states = <String, PrinterAiState>{};
  final service = AiServiceInfo();
  Timer? _tick, _health;

  /// True while the slicer runs: the AI service is stopped to give the slicer the memory and
  /// CPU cores, and no checks are made (a print is not watched during that time).
  bool get pausedForSlicer => service.pausedForSlicer;
  set pausedForSlicer(bool v) => service.pausedForSlicer = v;
  final _http = HttpClient()..connectionTimeout = const Duration(seconds: 3);

  AiMonitor(this.host, this.pi, this.serviceUrl, this.log);

  void start() {
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => _onTick());
    // Poll quickly until the service answers (model loading after boot), then every 30 s.
    _health = Timer.periodic(const Duration(seconds: 5), (_) {
      if (pausedForSlicer) return;
      final age = DateTime.now().difference(service.checkedAt ?? DateTime(2000)).inSeconds;
      if (!service.ready || age >= 30) checkHealth();
    });
    checkHealth();
  }

  void stop() {
    _tick?.cancel();
    _health?.cancel();
    _http.close(force: true);
  }

  PrinterAiState stateFor(String id) => states.putIfAbsent(id, () {
        final s = PrinterAiState(id);
        _loadLongTerm(s);
        return s;
      });

  File _stateFile(String id) => File('${host.dataRoot}/printers/$id/ai_state.json');

  void _loadLongTerm(PrinterAiState s) {
    try {
      s.prediction.loadLongTerm(jsonDecode(_stateFile(s.printerId).readAsStringSync()) as Map<String, dynamic>);
    } catch (_) {}
  }

  void _saveLongTerm(PrinterAiState s) {
    try {
      final f = _stateFile(s.printerId);
      f.parent.createSync(recursive: true);
      f.writeAsStringSync(jsonEncode(s.prediction.toJson()));
    } catch (_) {}
  }

  Future<void> checkHealth() async {
    try {
      final req = await _http.getUrl(serviceUrl.resolve('/health'));
      final res = await req.close().timeout(const Duration(seconds: 5));
      final j = jsonDecode(await utf8.decodeStream(res)) as Map<String, dynamic>;
      service
        ..reachable = true
        ..ready = j['ready'] == true
        ..model = j['model']?.toString() ?? ''
        ..backend = j['backend']?.toString() ?? ''
        ..error = j['error']?.toString() ?? ''
        ..avgMs = (j['avg_ms'] as num?)?.toDouble() ?? 0;
    } catch (e) {
      service
        ..reachable = false
        ..ready = false
        ..error = 'AI service not running ($e)';
    }
    service.checkedAt = DateTime.now();
  }

  void _onTick() {
    final now = DateTime.now();
    for (final inst in host.instances.values) {
      final b = inst.bridge;
      final s = stateFor(b.cfg.id);
      _trackJob(s, b);
      if (!pi.ai.enabledFor(b.cfg.id)) {
        s.status = 'off';
        s.message = 'Failure detection is switched off for this printer.';
        continue;
      }
      if (!b.online || b.jobState != 'printing') {
        if (b.jobState == 'paused' && s.pausedByAi) {
          s.status = 'paused';
          s.message = 'Paused by AI. Check the print, then resume or cancel it.';
        } else {
          s.status = 'idle';
          s.message = b.online
              ? (b.jobState == 'paused' ? 'Print is paused.' : 'Waiting for a print to start.')
              : 'Printer is offline.';
        }
        continue;
      }
      if (pausedForSlicer) {
        s.status = 'paused-slicer';
        s.message = 'Paused while the slicer is working. Starts again by itself when slicing is done.';
        continue;
      }
      if (!b.hasCamera) {
        s.status = 'no-camera';
        s.message = 'No camera found for this printer.';
        continue;
      }
      if (s.busy || now.isBefore(s.nextDue)) continue;
      s.nextDue = now.add(Duration(seconds: pi.ai.intervalSeconds));
      s.busy = true;
      _check(s, b).whenComplete(() => s.busy = false);
    }
    states.removeWhere((id, _) => !host.config.printers.any((p) => p.id == id));
  }

  /// Resets per-print state when a new job starts and re-arms after a resume.
  void _trackJob(PrinterAiState s, PrinterBridge b) {
    final js = b.jobState;
    final active = js == 'printing' || js == 'paused';
    if (active && (s.jobFile != b.jobFile || !(s.lastJobState == 'printing' || s.lastJobState == 'paused'))) {
      s.prediction.resetForNewPrint();
      s.jobFile = b.jobFile;
      s.warned = false;
      s.pausedByAi = false;
      s.ignored = false;
      s.history.clear();
    } else if (js == 'printing' && s.lastJobState == 'paused' && s.pausedByAi) {
      // User looked at it and resumed: give the print a fresh warm-up period.
      s.prediction.resetForNewPrint();
      s.pausedByAi = false;
      s.warned = false;
    }
    if (!active && s.lastJobState != js) _saveLongTerm(s);
    s.lastJobState = js;
  }

  Future<Map<String, dynamic>> _detect(Uint8List jpeg) async {
    final req = await _http.postUrl(serviceUrl.resolve('/detect'));
    req.headers.contentType = ContentType('image', 'jpeg');
    req.contentLength = jpeg.length;
    req.add(jpeg);
    final res = await req.close().timeout(const Duration(seconds: 60));
    final body = await utf8.decodeStream(res);
    if (res.statusCode != 200) throw HttpException('AI service HTTP ${res.statusCode}: $body');
    return jsonDecode(body) as Map<String, dynamic>;
  }

  /// Runs one detection now (also used by the "Test now" button on the setup page).
  Future<PrinterAiState> runOnce(PrinterBridge b, {bool updatePrediction = false}) async {
    final s = stateFor(b.cfg.id);
    final jpeg = await b.camera.snapshot();
    if (jpeg == null || jpeg.isEmpty) throw StateError('Could not get a camera picture: ${b.camera.lastError}');
    final r = await _detect(jpeg);
    final dets = [for (final d in (r['detections'] as List? ?? [])) Detection.fromJson(d)].whereType<Detection>().toList();
    s
      ..lastImage = jpeg
      ..lastDetections = dets
      ..imageWidth = (r['width'] as num?)?.toInt() ?? 0
      ..imageHeight = (r['height'] as num?)?.toInt() ?? 0
      ..lastInferenceMs = (r['ms'] as num?)?.toInt() ?? 0
      ..lastCheck = DateTime.now();
    if (updatePrediction) {
      s.prediction.update(dets);
      s.history.add(double.parse(s.prediction.ewmMean.toStringAsFixed(3)));
      while (s.history.length > 360) {
        s.history.removeAt(0);
      }
    }
    return s;
  }

  Future<void> _check(PrinterAiState s, PrinterBridge b) async {
    try {
      await runOnce(b, updatePrediction: true);
    } catch (e) {
      final offline = e is SocketException || e.toString().contains('AI service');
      s.status = offline ? 'ai-offline' : 'watching';
      s.message = offline ? 'The AI service is not answering yet (it can take a minute after boot).' : 'Camera problem: $e';
      return;
    }
    if (b.jobState != 'printing') return; // job changed while we were analysing
    final sens = pi.ai.sensitivityFactor;
    final warmingUp = s.prediction.currentFrameNum < FdParams.initSafeFrameNum;
    if (s.ignored) {
      s.status = 'ignored';
      s.message = 'Alerts muted for this print ("Not a failure" was pressed).';
      return;
    }
    if (pi.ai.action == 'pause' && !s.pausedByAi && s.prediction.isFailing(sens, escalatingFactor: FdParams.escalatingFactor)) {
      s.pausedByAi = true;
      s.warned = true;
      s.status = 'paused';
      s.message = 'Paused by AI. Check the print, then resume or cancel it.';
      var ok = false;
      try {
        ok = await b.client.pause();
      } catch (e) {
        log.warn('AI: pause failed on ${b.cfg.name}: $e');
      }
      log.warn('AI: likely print failure on ${b.cfg.name} (${b.jobFile}) - ${ok ? 'print paused' : 'pause FAILED'}');
      b.gcodeResponse('!! AI failure detection: the print looks like it is failing. ${ok ? 'The print was PAUSED.' : 'Pausing failed - check the printer!'}');
      _discord(b, s, paused: ok);
      return;
    }
    if (!s.warned && s.prediction.isFailing(sens)) {
      s.warned = true;
      s.status = 'warning';
      s.message = 'Possible print failure detected. Please check the printer.';
      log.warn('AI: possible print failure on ${b.cfg.name} (${b.jobFile}), ewm=${s.prediction.ewmMean.toStringAsFixed(2)}');
      b.gcodeResponse('!! AI failure detection: possible print failure (spaghetti). Please check the printer.');
      _discord(b, s, paused: false);
      return;
    }
    if (s.warned) {
      s.status = 'warning';
      s.message = 'Possible print failure detected. Please check the printer.';
    } else {
      s.status = 'watching';
      s.message = warmingUp
          ? 'Watching. Learning what a good print looks like (${s.prediction.currentFrameNum}/${FdParams.initSafeFrameNum}).'
          : 'Watching. Everything looks fine.';
    }
  }

  void _discord(PrinterBridge b, PrinterAiState s, {required bool paused}) {
    final d = DiscordNotifier(host.config.discordWebhook);
    if (!d.configured) return;
    d.send(
      title: paused ? 'Print paused by AI — ${b.cfg.name}' : 'Possible print failure — ${b.cfg.name}',
      description: '${b.jobFile}\nThe AI failure detection thinks this print may be failing. Please take a look.',
      color: paused ? 0xF44336 : 0xFFC107,
      fields: {
        'Progress': '${((b.client.last?.printProgress ?? 0) * 100).toStringAsFixed(0)}%',
        'AI score': s.prediction.ewmMean.toStringAsFixed(2),
      },
      image: s.lastImage,
    );
  }

  /// "Not a failure" button: mute alerts for the rest of this print.
  void ignore(String printerId) {
    final s = stateFor(printerId);
    s.ignored = true;
    s.warned = false;
    s.status = 'ignored';
    s.message = 'Alerts muted for this print ("Not a failure" was pressed).';
  }
}
