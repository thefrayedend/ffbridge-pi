// PrinterBridge: one FlashForge printer exposed as a Moonraker/Klipper instance.
// Owns the printer client, polling loop, job tracking, history, temperature store,
// camera relay, Spoolman usage tracking and Discord notifications.
import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'bridge_state.dart';
import 'config.dart';
import 'errors.dart';
import 'gcode.dart';
import 'ff/ff_client.dart';
import 'ff/models.dart';
import 'log.dart';
import 'mapping.dart';
import 'moonraker/database.dart';
import 'moonraker/file_manager.dart';
import 'moonraker/history.dart';
import 'services/camera_relay.dart';
import 'services/discord.dart';
import 'services/spoolman.dart';

class TempSeries {
  final temps = ListQueue<double>(), targets = ListQueue<double>(), powers = ListQueue<double>();
  void add(double t, double target, double p) {
    temps.add(t);
    targets.add(target);
    powers.add(p);
    while (temps.length > 1200) {
      temps.removeFirst();
      targets.removeFirst();
      powers.removeFirst();
    }
  }
}

class PrinterBridge {
  final PrinterConfig cfg;
  final AppConfig app;
  final String dataDir;
  late FlashForgeClient client;
  late StatusBuilder builder;
  late final FileManager files = FileManager(dataDir);
  late final MoonDatabase db = MoonDatabase(dataDir);
  late final JobHistory history = JobHistory(dataDir);
  late final MjpegRelay camera = MjpegRelay(cameraUrl);
  final SpoolmanClient spoolman;
  final DiscordNotifier discord;
  final Log log;

  bool online = false;
  String stateMessage = 'Connecting to printer...';
  final _events = StreamController<Map<String, dynamic>>.broadcast(); // JSON-RPC notifications
  final _changes = StreamController<void>.broadcast(); // UI refresh
  Stream<Map<String, dynamic>> get notifications => _events.stream;
  Stream<void> get changes => _changes.stream;

  Map<String, Map<String, dynamic>> status = {};
  final Map<String, TempSeries> tempStore = {};
  final gcodeStore = ListQueue<Map<String, dynamic>>();
  final DateTime startedAt = DateTime.now();

  // job tracking
  String jobFile = '';
  String jobState = 'standby';
  String jobMessage = '';
  double _lastPrintDuration = 0;
  DateTime? _jobStart;
  Timer? _pollTimer, _tempTimer, _fileTimer, _discordTimer;
  bool _polling = false, _disposed = false;
  int _failures = 0;
  String uploadStatus = '';

  PrinterBridge(this.cfg, this.app, this.dataDir, this.log)
      : spoolman = SpoolmanClient(app.spoolmanUrl),
        discord = DiscordNotifier(app.discordWebhook) {
    client = FlashForgeClient(cfg.ip, cfg.serial, cfg.checkCode);
    builder = StatusBuilder(client, levelBeforePrint: cfg.levelBeforePrint);
  }

  double get eventtime => DateTime.now().difference(startedAt).inMilliseconds / 1000.0;

  String cameraUrl() {
    if (cfg.cameraUrl.isNotEmpty) return cfg.cameraUrl;
    final u = client.last?.cameraStreamUrl ?? '';
    if (u.isNotEmpty) return u;
    if (client.isCreator5 || client.isPro || client.isAD5X || (client.last?.hasCamera ?? false)) {
      return 'http://${cfg.ip}:8080/?action=stream';
    }
    return '';
  }

  bool get hasCamera => cameraUrl().isNotEmpty;

  Future<void> start() async {
    _scheduleConnect(Duration.zero);
    _tempTimer = Timer.periodic(const Duration(seconds: 1), (_) => _sampleTemps());
    _fileTimer = Timer.periodic(const Duration(seconds: 30), (_) => refreshPrinterFiles());
    if (app.discordIntervalMinutes > 0) {
      _discordTimer = Timer.periodic(Duration(minutes: app.discordIntervalMinutes), (_) {
        if (jobState == 'printing') _notifyDiscord('progress');
      });
    }
  }

  void _scheduleConnect(Duration d) {
    if (_disposed) return;
    Timer(d, _connect);
  }

  Future<void> _connect() async {
    if (_disposed) return;
    try {
      stateMessage = 'Connecting to ${cfg.ip}...';
      await client.connect();
      online = true;
      _failures = 0;
      stateMessage = 'Printer is ready';
      if (cfg.model != client.model) {
        cfg.model = client.model;
        app.save();
      }
      log.info('Connected to ${client.model} (${client.name}) fw ${client.firmware} at ${cfg.ip}; tools=${client.nozzleCount} '
          'httpOnly=${client.httpOnly} caps=${client.caps.toJson()}');
      _initTempStore();
      _writeMainsailDefaults();
      _updateFromDetail(client.last!, initial: true);
      _emit('notify_klippy_ready', []);
      refreshPrinterFiles();
      _pollTimer?.cancel();
      _pollLoop();
    } catch (e) {
      online = false;
      stateMessage = 'Cannot reach FlashForge printer at ${cfg.ip}: $e';
      log.warn(stateMessage);
      _rebuild();
      _scheduleConnect(const Duration(seconds: 5));
    }
  }

  /// Mainsail reads config/.theme/default.json the first time it starts with an empty
  /// database. Use it to name the printer and hide panels the printer can't support
  /// (jogging / extrusion / motion limits are not available over the Creator 5 LAN API).
  void _writeMainsailDefaults() {
    try {
      final f = File('${files.config.path}/.theme/default.json');
      f.parent.createSync(recursive: true);
      final hide = client.httpOnly;
      List<Map<String, dynamic>> l(List<String> names) => [
            for (final n in names) {'name': n, 'visible': !(hide && const ['toolhead-control', 'extruder-control', 'machine-settings'].contains(n))}
          ];
      final defaults = {
        // keys are written directly into Mainsail's 'mainsail' database namespace
        ...{
          'general': {'printername': cfg.name},
          'uiSettings': {'logo': '#D41216', 'primary': '#2196F3', 'boolBigThumbnail': true},
          'dashboard': {
            'mobileLayout': l(['webcam', 'macros', 'miscellaneous', 'temperature', 'toolhead-control', 'extruder-control', 'machine-settings', 'miniconsole']),
            'tabletLayout1': l(['webcam', 'macros', 'miscellaneous', 'toolhead-control', 'extruder-control', 'machine-settings']),
            'tabletLayout2': l(['temperature', 'miniconsole']),
            'desktopLayout1': l(['webcam', 'macros', 'miscellaneous', 'toolhead-control', 'extruder-control', 'machine-settings']),
            'desktopLayout2': l(['temperature', 'miniconsole']),
            'widescreenLayout1': l(['macros', 'miscellaneous', 'toolhead-control', 'extruder-control']),
            'widescreenLayout2': l(['temperature', 'machine-settings']),
            'widescreenLayout3': l(['webcam', 'miniconsole']),
          },
        },
      };
      f.writeAsStringSync(jsonEncode(defaults));
    } catch (e) {
      log.warn('Could not write Mainsail defaults: $e');
    }
  }

  void _initTempStore() {
    for (final n in [...extruderNames(builder.toolCount), 'heater_bed', if (client.caps.chamber) 'heater_generic chamber']) {
      tempStore.putIfAbsent(n, TempSeries.new);
    }
  }

  void _pollLoop() {
    if (_disposed) return;
    final busy = jobState == 'printing' || jobState == 'paused' || (client.last?.state == MachineState.heating);
    _pollTimer = Timer(Duration(milliseconds: busy ? 1000 : 2000), () async {
      await poll();
      if (online) _pollLoop();
    });
  }

  Future<void> poll() async {
    if (_polling || _disposed) return;
    _polling = true;
    try {
      final d = await client.detail();
      _failures = 0;
      if (!online) {
        online = true;
        stateMessage = 'Printer is ready';
        _emit('notify_klippy_ready', []);
      }
      _updateFromDetail(d);
    } catch (e) {
      _failures++;
      if (_failures >= 3 && online) {
        online = false;
        stateMessage = 'Lost connection to printer at ${cfg.ip}: $e';
        log.warn(stateMessage);
        _rebuild();
        _emit('notify_klippy_shutdown', []);
        _pollTimer?.cancel();
        _scheduleConnect(const Duration(seconds: 5));
      }
    } finally {
      _polling = false;
    }
  }

  void _updateFromDetail(PrinterDetail d, {bool initial = false}) {
    final st = d.state;
    final fname = d.printFileName;
    final active = st == MachineState.printing ||
        st == MachineState.pausing ||
        st == MachineState.paused ||
        ((st == MachineState.heating || st == MachineState.calibrating || st == MachineState.busy) && fname.isNotEmpty && d.printProgress < 1);
    String newState;
    if (active) {
      newState = (st == MachineState.paused) ? 'paused' : 'printing';
    } else if (st == MachineState.completed) {
      newState = 'complete';
    } else if (st == MachineState.cancelled) {
      newState = 'cancelled';
    } else if (st == MachineState.error) {
      newState = 'error';
    } else {
      newState = 'standby';
    }
    final prev = jobState;
    if (newState != prev || (active && fname.isNotEmpty && fname != jobFile)) {
      _onJobTransition(prev, newState, d);
    }
    jobState = newState;
    if (fname.isNotEmpty) jobFile = fname;
    final err = currentError;
    if ((err?.code ?? '') != _lastErrorCode) {
      _lastErrorCode = err?.code ?? '';
      if (err != null) {
        gcodeResponse('!! Printer error ${err.code}: ${err.title}. ${err.fix}');
        log.warn('${cfg.name}: printer error ${err.code} (${err.title})');
      }
    }
    jobMessage = newState == 'error'
        ? (err == null ? 'Printer error' : 'Printer error ${err.code}: ${err.title}')
        : (newState == 'paused' ? (err == null ? 'Paused' : 'Paused — ${err.code}: ${err.title}') : '');
    if (active) _lastPrintDuration = d.printDuration;
    _rebuild();
  }

  String _lastErrorCode = '';

  /// Plain-English explanation of the printer's current error code (null = no error).
  PrinterError? get currentError =>
      explainError(client.last?.errorCode ?? '', client.isCreator5 ? 'creator5' : (client.isAD5X ? 'ad5x' : '5m'));

  void _onJobTransition(String from, String to, PrinterDetail d) {
    final fname = d.printFileName;
    if ((to == 'printing' || to == 'paused') && (from != 'printing' && from != 'paused' || fname != jobFile)) {
      _clearPending();
      jobFile = fname;
      _jobStart = DateTime.now();
      final cur = history.current;
      if (cur != null && (cur['filename'] == fname || cur['filename'] == FileManager.displayName(fname))) {
        // bridge restarted mid-print: keep tracking the existing job
        _jobStart = DateTime.fromMillisecondsSinceEpoch(((cur['start_time'] as num) * 1000).round());
        return;
      }
      final meta = files.metadataFor(fname) ?? {};
      if (cur != null) history.finish('interrupted');
      final job = history.start(FileManager.displayName(fname), meta);
      _emit('notify_history_changed', [
        {'action': 'added', 'job': job}
      ]);
      gcodeResponse('// Print started: $fname');
      if (app.notifyOnStart) _notifyDiscord('started');
    } else if (to == 'paused' && from == 'printing') {
      gcodeResponse('// Print paused');
      if (app.notifyOnPause) _notifyDiscord('paused');
    } else if (to == 'printing' && from == 'paused') {
      gcodeResponse('// Print resumed');
    } else if ((from == 'printing' || from == 'paused') && (to == 'complete' || to == 'cancelled' || to == 'error' || to == 'standby')) {
      final status = to == 'complete' ? 'completed' : (to == 'standby' ? 'completed' : to);
      final progress = to == 'complete' || to == 'standby' ? 1.0 : (client.last?.printProgress ?? 0);
      final used = _filamentUsed(progress);
      final job = history.finish(status == 'error' ? 'error' : status, printDuration: _lastPrintDuration, filamentUsed: used);
      if (job != null) {
        _emit('notify_history_changed', [
          {'action': 'finished', 'job': job}
        ]);
      }
      gcodeResponse('// Print ${status == 'completed' ? 'finished' : status}: $jobFile');
      _trackSpool(progress);
      if (to == 'error' ? app.notifyOnError : app.notifyOnComplete) _notifyDiscord(status);
      if (cfg.autoClearPlatform && (to == 'complete' || to == 'cancelled')) _scheduleAutoClear(to);
    } else if (from == 'standby' && history.current != null && (to == 'complete' || to == 'cancelled' || to == 'error')) {
      // job finished while the bridge was not running
      history.finish(to == 'complete' ? 'completed' : to, printDuration: d.printDuration, filamentUsed: _filamentUsed(d.printProgress));
    }
  }

  /// FlashForge printers show a "print finished" message that blocks the next print until
  /// "clear platform" is sent. With the printer option on, the bridge sends it by itself a few
  /// seconds after a print ends (after the Discord picture of the finished print is taken).
  void _scheduleAutoClear(String endedAs) {
    Timer(const Duration(seconds: 8), () async {
      if (_disposed || !online || jobState != endedAs) return; // already cleared, or a new job started
      try {
        if (await client.clearPlatform()) {
          gcodeResponse('// Cleared the platform automatically (printer option "auto clear platform")');
          log.info('${cfg.name}: platform cleared automatically after the print ${endedAs == 'complete' ? 'finished' : 'was cancelled'}');
        }
      } catch (e) {
        log.warn('${cfg.name}: automatic clear platform failed: $e');
      }
      Future.delayed(const Duration(seconds: 1), poll);
    });
  }

  double _filamentUsed(double progress) {
    final d = client.last;
    var total = d?.estimatedRightLen ?? 0;
    if (total <= 0) total = ((files.metadataFor(jobFile)?['filament_total']) as num?)?.toDouble() ?? 0;
    return total * progress;
  }

  double _filamentWeight(double progress) {
    final d = client.last;
    var total = d?.estimatedRightWeight ?? 0;
    if (total <= 0) total = ((files.metadataFor(jobFile)?['filament_weight_total']) as num?)?.toDouble() ?? 0;
    return total * progress;
  }

  int? get activeSpoolId {
    try {
      final v = db.getItem('moonraker', 'spoolman.spool_id');
      return v is int ? v : (v is num ? v.toInt() : null);
    } catch (_) {
      return null;
    }
  }

  set activeSpoolId(int? id) {
    db.postItem('moonraker', 'spoolman.spool_id', id);
    _emit('notify_active_spool_set', [
      {'spool_id': id}
    ]);
    _changes.add(null);
  }

  Future<void> _trackSpool(double progress) async {
    final id = activeSpoolId;
    if (id == null || id == 0 || !spoolman.configured) return;
    try {
      final w = _filamentWeight(progress);
      final l = _filamentUsed(progress);
      await spoolman.useFilament(id, weightG: w > 0 ? w : null, lengthMm: l);
      gcodeResponse('// Spoolman: deducted ${w > 0 ? '${w.toStringAsFixed(1)} g' : '${l.toStringAsFixed(0)} mm'} from spool $id');
    } catch (e) {
      log.warn('Spoolman update failed: $e');
    }
  }

  void _sampleTemps() {
    if (!online) return;
    for (final e in tempStore.entries) {
      final s = status[e.key];
      if (s == null) continue;
      e.value.add((s['temperature'] as num).toDouble(), (s['target'] as num).toDouble(), (s['power'] as num).toDouble());
    }
  }

  // --------------- status / notifications ---------------
  final Map<String, Map<String, dynamic>> _lastSent = {};

  void _rebuild() {
    final now = DateTime.now();
    final total = _jobStart != null && (jobState == 'printing' || jobState == 'paused') ? now.difference(_jobStart!).inMilliseconds / 1000.0 : 0.0;
    final d = client.last;
    final active = jobState == 'printing' || jobState == 'paused' || jobState == 'complete';
    final fileSize = (files.metadataFor(jobFile)?['size'] as int?) ?? 0;
    status = builder.build(
      online: online,
      stateMessage: stateMessage,
      filename: FileManager.displayName(active ? jobFile : (jobState == 'standby' ? '' : jobFile)),
      printDuration: active ? (d?.printDuration ?? 0) : 0,
      totalDuration: active ? (total > (d?.printDuration ?? 0) ? total : (d?.printDuration ?? 0)) : 0,
      filamentUsed: active ? _filamentUsed(jobState == 'complete' ? 1.0 : (d?.printProgress ?? 0)) : 0,
      jobState: jobState,
      jobMessage: jobMessage,
      fileSize: fileSize,
    );
    if (online || status.isNotEmpty) status['configfile'] = builder.configfile();
    status['gcode'] = {'commands': GcodeRunner.commandsHelp(this)};
    // diff
    final diff = <String, dynamic>{};
    status.forEach((obj, fields) {
      if ((obj == 'configfile' || obj == 'gcode') && _lastSent.containsKey(obj)) return;
      final prev = _lastSent[obj];
      final changed = <String, dynamic>{};
      fields.forEach((k, v) {
        if (prev == null || !_deepEq(prev[k], v)) changed[k] = v;
      });
      if (changed.isNotEmpty) diff[obj] = changed;
      _lastSent[obj] = Map<String, dynamic>.from(fields);
    });
    if (diff.isNotEmpty) _emit('notify_status_update', [diff, eventtime]);
    _changes.add(null);
  }

  static bool _deepEq(dynamic a, dynamic b) {
    if (a is List && b is List) {
      if (a.length != b.length) return false;
      for (var i = 0; i < a.length; i++) {
        if (!_deepEq(a[i], b[i])) return false;
      }
      return true;
    }
    if (a is Map && b is Map) {
      if (a.length != b.length) return false;
      for (final k in a.keys) {
        if (!b.containsKey(k) || !_deepEq(a[k], b[k])) return false;
      }
      return true;
    }
    return a == b;
  }

  void _emit(String method, List<dynamic> params) {
    if (_events.isClosed) return;
    _events.add({'jsonrpc': '2.0', 'method': method, 'params': params});
  }

  void emitRaw(String method, List<dynamic> params) => _emit(method, params);

  void gcodeResponse(String msg, {String type = 'response'}) {
    gcodeStore.add({'message': msg, 'time': DateTime.now().millisecondsSinceEpoch / 1000.0, 'type': type});
    while (gcodeStore.length > 1000) {
      gcodeStore.removeFirst();
    }
    if (type == 'response') _emit('notify_gcode_response', [msg]);
  }

  // --------------- files on the printer ---------------
  Future<void> refreshPrinterFiles() async {
    if (!online) return;
    try {
      final list = await client.recentFiles();
      files.updatePrinterFiles([for (final f in list) f.name], {for (final f in list) f.name: f.printingTime});
      _emit('notify_filelist_changed', [
        {'action': 'refresh', 'item': {'root': 'gcodes', 'path': ''}}
      ]);
      for (final f in list) {
        if (!files.isLocal(f.name) && !files.hasPrinterThumb(f.name)) {
          final png = await client.thumbnail(f.name);
          if (png != null && png.isNotEmpty) files.setPrinterThumb(f.name, png);
        }
      }
    } catch (e) {
      log.warn('File list refresh failed: $e');
    }
  }

  // --------------- printing ---------------
  Future<void> startPrint(String filename, {List<MaterialMapping>? mappings}) async {
    if (!online) throw RpcError(503, 'Printer is offline');
    if (jobState == 'printing' || jobState == 'paused') throw RpcError(400, 'Printer is busy');
    final level = cfg.levelBeforePrint;
    filename = files.resolve(filename);
    final name = filename.split('/').last;
    final local = files.fileFor('gcodes', filename);
    final onPrinter = files.printerFiles.containsKey(name);
    if (mappings == null) {
      final plan = smartMapping(filename);
      if (plan != null) {
        if (app.mappingMode == 'always' || !plan.confident) {
          // Hold the job and ask in Mainsail (also shown in OrcaSlicer's Device tab).
          if (local.existsSync() && !onPrinter) await uploadToPrinter(local, name, printNow: false);
          _pendingMapping = plan;
          _pendingFile = filename;
          gcodeResponse(plan.confident
              ? '// $name is waiting: check the filament slots in the pop-up, then press Start print'
              : '!! $name: the loaded filaments don\'t match the slicer file. Choose the slots in the pop-up, then press Start print.');
          showMappingPrompt();
          _changes.add(null);
          return;
        }
        mappings = plan.toMappings();
        _logMapping(plan);
      }
    }
    if (local.existsSync() && !onPrinter) {
      await uploadToPrinter(local, name, printNow: false);
    }
    gcodeResponse('// Starting $name${level ? ' (with bed leveling)' : ''}');
    try {
      try {
        await client.printLocal(name, leveling: level, mappings: mappings);
      } catch (e) {
        // A finished/cancelled job must be acknowledged (plate cleared) before the next one.
        if (jobState == 'complete' || jobState == 'cancelled') {
          gcodeResponse('// Clearing the finished job on the printer first');
          await client.clearPlatform();
          await Future.delayed(const Duration(seconds: 2));
          await client.printLocal(name, leveling: level, mappings: mappings);
        } else {
          rethrow;
        }
      }
    } catch (e) {
      if (local.existsSync()) {
        gcodeResponse('// Printer did not accept the stored file, re-uploading...');
        await uploadToPrinter(local, name, printNow: true, mappings: mappings);
      } else {
        rethrow;
      }
    }
    Future.delayed(const Duration(milliseconds: 1500), poll);
  }

  // --------------- multi-colour filament mapping ---------------
  MappingPlan? _pendingMapping;
  String _pendingFile = '';
  MappingPlan? get pendingMapping => _pendingMapping;

  /// Smart slicer-filament -> slot plan for .3mf jobs on material-station printers (null = nothing to map).
  MappingPlan? smartMapping(String filename) {
    if (!filename.toLowerCase().endsWith('.3mf')) return null;
    if (!(client.isCreator5 || client.isAD5X)) return null;
    final meta = files.metadataFor(filename) ?? {};
    final fils = (meta['mmu_filaments'] as List?) ?? const [];
    final slots = client.last?.slots ?? const <SlotInfo>[];
    if (fils.isEmpty || slots.isEmpty) return null;
    final list = <SlicerFilament>[];
    for (var i = 0; i < fils.length && i < 4; i++) {
      final f = fils[i] as Map;
      final c = normalizeColor(f['color']?.toString() ?? '');
      list.add(SlicerFilament(((f['id'] as int?) ?? (i + 1)) - 1, f['type']?.toString() ?? '', c.isEmpty ? '#FFFFFF' : c));
    }
    return planMapping(filename.split('/').last, list, slots);
  }

  /// Kept for callers of the old API: the smart plan as printer mappings.
  List<MaterialMapping>? defaultMappings(String filename) => smartMapping(filename)?.toMappings();

  String _desc(String color, String material) => '${colorName(color)} ${material.isEmpty ? 'filament' : material}';

  void _logMapping(MappingPlan plan) {
    for (final l in plan.lines) {
      gcodeResponse('// Filament ${l.filament.index + 1} (${_desc(l.filament.color, l.filament.type)}) -> slot ${l.slot.slotId} '
          '(${_desc(l.slot.color, l.slot.material)}): ${l.verdict}');
    }
  }

  void _action(String a) => gcodeResponse('// action:$a');

  /// Mainsail "macro prompt" dialog: one row of slot buttons per slicer filament.
  void showMappingPrompt() {
    final p = _pendingMapping;
    if (p == null) return;
    _action('prompt_begin Choose filament slots');
    _action('prompt_text ${p.file} uses ${p.lines.length} filament${p.lines.length == 1 ? '' : 's'}. '
        '${p.confident ? 'Everything matches - check and press Start print.' : 'Not everything matches what is loaded. Pick a slot for each filament.'}');
    for (final l in p.lines) {
      final n = l.filament.index + 1;
      _action('prompt_text Filament $n: ${_desc(l.filament.color, l.filament.type)} (${l.filament.color}) -> slot ${l.slot.slotId} = '
          '${_desc(l.slot.color, l.slot.material)} - ${l.verdict}');
      _action('prompt_button_group_start');
      for (final s in p.slots) {
        final on = s.slotId == l.slot.slotId;
        _action('prompt_button ${on ? '> ' : ''}Slot ${s.slotId}: ${_desc(s.color, s.material)}|FFB_MAP_SLOT FILAMENT=$n SLOT=${s.slotId}|${on ? 'primary' : 'secondary'}');
      }
      _action('prompt_button_group_end');
    }
    _action('prompt_footer_button Cancel|FFB_MAP_CANCEL|error');
    _action('prompt_footer_button Start print|FFB_MAP_START|primary');
    _action('prompt_show');
  }

  void setPendingSlot(int filamentNumber, int slotId) {
    final p = _pendingMapping;
    if (p == null) throw RpcError(400, 'No print is waiting for filament slots');
    try {
      p.setSlot(filamentNumber - 1, slotId);
    } on ArgumentError catch (e) {
      throw RpcError(400, e.message.toString());
    }
    showMappingPrompt();
  }

  Future<void> confirmPendingPrint() async {
    final p = _pendingMapping;
    if (p == null) throw RpcError(400, 'No print is waiting for filament slots');
    _clearPending();
    _logMapping(p);
    await startPrint(_pendingFile, mappings: p.toMappings());
  }

  void cancelPendingPrint() {
    if (_pendingMapping == null) return;
    gcodeResponse('// Print of ${_pendingMapping!.file} cancelled');
    _clearPending();
  }

  void _clearPending() {
    if (_pendingMapping == null) return;
    _pendingMapping = null;
    _action('prompt_end');
    _changes.add(null);
  }

  Future<void> uploadToPrinter(File f, String name, {bool printNow = false, List<MaterialMapping>? mappings}) async {
    final tools = files.toolCount(name);
    var lastPct = -10;
    uploadStatus = 'Uploading $name to printer...';
    _changes.add(null);
    try {
      await client.upload(f, name, printNow: printNow, leveling: cfg.levelBeforePrint, toolCount: tools, mappings: mappings,
          onProgress: (sent, total) {
        final pct = total == 0 ? 100 : (sent * 100 ~/ total);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          uploadStatus = 'Uploading $name to printer: $pct%';
          gcodeResponse('// $uploadStatus');
          _changes.add(null);
        }
      });
      files.printerFiles[name] = DateTime.now().millisecondsSinceEpoch / 1000.0;
      gcodeResponse('// Upload to printer complete: $name');
    } finally {
      uploadStatus = '';
      _changes.add(null);
    }
  }

  // --------------- Discord ---------------
  Future<void> _notifyDiscord(String event) async {
    discord.webhookUrl = app.discordWebhook;
    if (!discord.configured) return;
    final d = client.last;
    final colors = {'started': 0x2196F3, 'progress': 0x2196F3, 'paused': 0xFFC107, 'completed': 0x4CAF50, 'cancelled': 0x9E9E9E, 'error': 0xF44336};
    final titles = {
      'started': 'Print started',
      'progress': 'Print progress',
      'paused': 'Print paused',
      'completed': 'Print finished',
      'cancelled': 'Print cancelled',
      'error': 'Printer error'
    };
    Uint8List? snap;
    if (app.discordSnapshot && hasCamera) snap = await camera.snapshot();
    final fields = <String, String>{
      'Progress': '${((d?.printProgress ?? 0) * 100).toStringAsFixed(0)}%',
      'Layer': '${d?.printLayer ?? 0}/${d?.targetPrintLayer ?? 0}',
      'Elapsed': _fmt(d?.printDuration ?? 0),
      if (event == 'progress' || event == 'started') 'Remaining': _fmt(d?.estimatedTime ?? 0),
    };
    final temps = d?.toolTemps ?? [];
    for (var i = 0; i < temps.length; i++) {
      if (temps[i].target > 0 || temps.length == 1) fields['T$i'] = '${temps[i].current.round()}/${temps[i].target.round()}°C';
    }
    fields['Bed'] = '${d?.bed.current.round() ?? 0}/${d?.bed.target.round() ?? 0}°C';
    await discord.send(
      title: '${titles[event] ?? event} — ${cfg.name}',
      description: [
        jobFile.isEmpty ? client.model : jobFile,
        if (currentError != null) '**${currentError!.code}: ${currentError!.title}**\n${currentError!.fix}',
      ].join('\n\n'),
      color: colors[event] ?? 0x2196F3,
      fields: fields,
      image: snap,
    );
  }

  static String _fmt(double s) {
    final h = s ~/ 3600, m = (s % 3600) ~/ 60;
    return h > 0 ? '${h}h ${m}m' : '${m}m';
  }

  Future<void> reconnect() async {
    _pollTimer?.cancel();
    online = false;
    stateMessage = 'Reconnecting...';
    _rebuild();
    _emit('notify_klippy_disconnected', []);
    await client.dispose().catchError((_) {});
    client = FlashForgeClient(cfg.ip, cfg.serial, cfg.checkCode);
    builder = StatusBuilder(client, levelBeforePrint: cfg.levelBeforePrint);
    _scheduleConnect(const Duration(milliseconds: 500));
  }

  Future<void> dispose() async {
    _disposed = true;
    _pollTimer?.cancel();
    _tempTimer?.cancel();
    _fileTimer?.cancel();
    _discordTimer?.cancel();
    camera.dispose();
    db.flush();
    await client.dispose().catchError((_) {});
    await _events.close();
    await _changes.close();
  }
}
