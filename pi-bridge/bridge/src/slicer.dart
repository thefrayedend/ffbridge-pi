// Slicer: the OrcaSlicer engine (Helio Additive's slicer-cli, AGPL-3.0) behind the web UI.
//
// The browser does the 3D work (placing, painting, previewing) and sends the plate as a 3MF.
// The board runs the engine with the selected printer's Flashforge profiles and hands the
// G-code to the normal print flow (filament check, colour mapping, start).
//
// Printer lock: the engine is only ever started with the printer preset that belongs to the
// printer the person has open. Process and filament presets are checked against that printer's
// own list, and a project file's embedded printer / settings never get a say (the browser does
// not send them, and the engine's command-line presets win over anything in a 3MF anyway).
//
// The engine is not part of the SD card image: Settings -> General -> Slicer downloads it
// (~35 MB) from this project's GitHub release into <data>/slicer/engine.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'core.dart';
import 'pi_config.dart';

const slicerSourceUrl = 'https://github.com/Helio-Additive/slicer-cli';

class Slicer {
  final BridgeHost host;
  final PiConfig pi;
  final String dir; // <data>/slicer
  final String? engineOverride; // dev: a slicer-cli folder (any platform the engine runs on)
  final String repo; // owner/name for the engine download

  Slicer(this.host, this.pi, String dataDir, {this.engineOverride, this.repo = ''}) : dir = '$dataDir/slicer' {
    _loadModels();
  }

  String get engineDir => engineOverride ?? '$dir/engine';
  String get exe => '$engineDir/bin/slicer_cli-orcaslicer';
  bool get installed => File(exe).existsSync();
  String get engineVersion {
    try {
      return File('$engineDir/VERSION').readAsStringSync().trim();
    } catch (_) {
      return installed ? 'dev' : '';
    }
  }

  // ------------------------------------------------------------------ running the engine
  Map<String, String> get _env {
    final rt = Directory('$engineDir/rt');
    return rt.existsSync() ? {'LD_LIBRARY_PATH': '${rt.path}:$engineDir/lib'} : {};
  }

  /// Called before a slice starts and ~20 s after the last one ended (main: pause / resume the
  /// AI service, so the slicer gets its memory and cores). Never called for quick lookups.
  Future<void> Function()? beforeSlice;
  Future<void> Function()? afterSlices;
  Timer? _resumeTimer;
  bool _held = false;

  Future<void> _hold() async {
    _resumeTimer?.cancel();
    _resumeTimer = null;
    if (_held) return;
    _held = true;
    try {
      await beforeSlice?.call().timeout(const Duration(seconds: 40));
    } catch (e) {
      host.log.warn('Could not pause the AI for slicing: $e');
    }
  }

  void _release() {
    _resumeTimer?.cancel();
    // A short wait: "Slice all plates" starts the next plate right away; no stop/start in between.
    _resumeTimer = Timer(const Duration(seconds: 20), () async {
      if (running != null || !_held) return;
      _held = false;
      try {
        await afterSlices?.call();
      } catch (e) {
        host.log.warn('Could not start the AI again after slicing: $e');
      }
    });
  }

  static List<int>? _cpuList;

  /// The cores the engine may use: the fastest ones, at most [maxSlicerCores]. The engine's
  /// thread pool (TBB) sizes itself to these, so it never runs a worker on every core; the
  /// other cores stay free for the printer connections and the web pages.
  static List<int> get slicerCpus => _cpuList ??= () {
        final cap = <int, int>{};
        try {
          for (final d in Directory('/sys/devices/system/cpu').listSync()) {
            final m = RegExp(r'/cpu(\d+)$').firstMatch(d.path);
            if (m == null) continue;
            final n = int.parse(m.group(1)!);
            final online = File('${d.path}/online');
            if (online.existsSync() && online.readAsStringSync().trim() == '0') continue;
            final c = File('${d.path}/cpu_capacity');
            cap[n] = c.existsSync() ? int.tryParse(c.readAsStringSync().trim()) ?? 1024 : 1024;
          }
        } catch (_) {}
        return pickCpus(cap, maxSlicerCores);
      }();

  Future<Process> _start(List<String> args, String cwd) async {
    final env = _env;
    final cpus = Platform.isLinux && File('/usr/bin/taskset').existsSync() ? slicerCpus : const <int>[];
    final Process p;
    if (cpus.isNotEmpty) {
      // taskset and env replace themselves with the engine (same process). The engine's own C
      // library path goes to the engine only: a system program started with it would crash.
      p = await Process.start('taskset', [
        '-c', cpus.join(','),
        if (env.isNotEmpty) ...['env', ...env.entries.map((e) => '${e.key}=${e.value}')],
        exe, ...args,
      ], workingDirectory: cwd);
    } else {
      p = await Process.start(exe, args, workingDirectory: cwd, environment: env);
    }
    if (Platform.isLinux) {
      // Lower priority than the printer connections: a long slice never makes the printer screen lag.
      Process.run('renice', ['-n', '10', '-p', '${p.pid}']).ignore();
      // If memory runs out anyway, the kernel stops the slicer, not the bridge or the AI.
      try {
        File('/proc/${p.pid}/oom_score_adj').writeAsStringSync('1000');
      } catch (_) {}
    }
    return p;
  }

  Future<String> _runJson(List<String> args) async {
    final tmp = Directory('$dir/tmp')..createSync(recursive: true);
    final p = await _start(args, tmp.path);
    final out = StringBuffer();
    final err = StringBuffer();
    final a = p.stdout.transform(utf8.decoder).forEach(out.write);
    final b = p.stderr.transform(utf8.decoder).forEach(err.write);
    final code = await p.exitCode.timeout(const Duration(minutes: 3), onTimeout: () {
      p.kill();
      return -1;
    });
    await Future.wait([a, b]);
    if (code != 0) throw SlicerException('The slicer engine failed ($code): ${_lastLines(err.toString())}');
    final s = out.toString();
    final i = s.indexOf('{');
    if (i < 0) throw SlicerException('The slicer engine gave no answer.');
    return s.substring(i);
  }

  static String _lastLines(String s) => s.trim().split('\n').reversed.take(3).toList().reversed.join(' / ');

  // ------------------------------------------------------------------ caches
  final Map<String, Object?> _mem = {};
  File _cacheFile(String key) => File('$dir/cache/${engineVersion.isEmpty ? 'x' : engineVersion}/${key.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_')}.json');

  Future<dynamic> _cached(String key, Future<dynamic> Function() make) async {
    if (_mem.containsKey(key)) return _mem[key];
    final f = _cacheFile(key);
    if (f.existsSync()) {
      try {
        return _mem[key] = jsonDecode(f.readAsStringSync());
      } catch (_) {}
    }
    final v = await make();
    f.parent.createSync(recursive: true);
    f.writeAsStringSync(jsonEncode(v));
    return _mem[key] = v;
  }

  void _clearCaches() {
    _mem.clear();
    try {
      Directory('$dir/cache').deleteSync(recursive: true);
    } catch (_) {}
  }

  /// Every Flashforge printer the engine knows: [{name, model}].
  Future<List<Map<String, String>>> enginePrinters() async {
    final v = await _cached('printers', () async {
      final j = jsonDecode(await _runJson(['--list-presets'])) as Map<String, dynamic>;
      return [
        for (final p in (j['printers'] as List? ?? []))
          if ('${p['name']}'.toLowerCase().startsWith('flashforge')) {'name': '${p['name']}', 'model': '${p['printer_model'] ?? ''}'}
      ];
    });
    return [for (final p in v as List) {'name': '${p['name']}', 'model': '${p['model']}'}];
  }

  /// The presets that go with one engine printer, Flashforge filaments only.
  Future<Map<String, dynamic>> presetsFor(String machine) async {
    final v = await _cached('presets-$machine', () async {
      final j = jsonDecode(await _runJson(['--list-presets', '--printer', machine])) as Map<String, dynamic>;
      return {
        'processes': j['processes'] ?? [],
        'defaultProcess': j['default_process'] ?? '',
        'filaments': flashforgeFilaments([for (final f in (j['filaments'] as List? ?? [])) '$f']),
        'defaultBedType': j['default_bed_type'] ?? '',
      };
    });
    return Map<String, dynamic>.from(v as Map);
  }

  /// Every setting with its value for a printer + process (what the "All settings" list shows).
  Future<Map<String, dynamic>> resolved(String machine, String process) async {
    final v = await _cached('resolved-$machine-$process', () async {
      final tmp = Directory('$dir/tmp')..createSync(recursive: true);
      final stl = File('${tmp.path}/probe.stl')..writeAsBytesSync(probeStl());
      final out = File('${tmp.path}/resolved.json');
      if (out.existsSync()) out.deleteSync();
      final p = await _start([stl.path, '--printer-preset', machine, '--process-preset', process, '--export-settings', out.path], tmp.path);
      p.stdout.drain<void>();
      final err = StringBuffer();
      final e = p.stderr.transform(utf8.decoder).forEach(err.write);
      final code = await p.exitCode.timeout(const Duration(minutes: 3), onTimeout: () {
        p.kill();
        return -1;
      });
      await e;
      if (code != 0 || !out.existsSync()) throw SlicerException('Could not read the profile settings: ${_lastLines(err.toString())}');
      return jsonDecode(out.readAsStringSync());
    });
    return Map<String, dynamic>.from(v as Map);
  }

  /// The settings the engine has, reduced to what a person can change for one print.
  Future<List<dynamic>> schema() async {
    final v = await _cached('schema', () async {
      final j = jsonDecode(await _runJson(['--list-settings'])) as Map<String, dynamic>;
      return [
        for (final s in (j['settings'] as List? ?? []))
          if ((s['scope'] == 'process' || s['key'] == 'curr_bed_type') && (s['label'] ?? '').toString().isNotEmpty && overridable(Map<String, dynamic>.from(s as Map)))
            {
              for (final k in ['key', 'label', 'category', 'type', 'mode', 'tooltip', 'unit', 'min', 'max', 'enum', 'vector'])
                if (s[k] != null) k: s[k]
            }
      ];
    });
    return v as List;
  }

  /// Settings a print may change: plain numbers, switches and choices. Never text settings (that
  /// is where post-processing scripts, custom G-code and file names live).
  Future<Set<String>> _settingKeys() async => {
        for (final s in await schema())
          if (overridable(Map<String, dynamic>.from(s as Map))) '${s['key']}'
      };

  // ------------------------------------------------------------------ printer -> engine printer
  /// Remembered per printer: {model, machine}. The model is learnt while the printer is online.
  Map<String, Map<String, String>> _models = {};
  File get _modelsFile => File('$dir/printers.json');
  void _loadModels() {
    try {
      final j = jsonDecode(_modelsFile.readAsStringSync()) as Map<String, dynamic>;
      _models = {for (final e in j.entries) e.key: Map<String, String>.from(e.value as Map)};
    } catch (_) {}
  }

  void _saveModels() {
    _modelsFile.parent.createSync(recursive: true);
    _modelsFile.writeAsStringSync(jsonEncode(_models));
  }

  String _modelOf(String printerId) {
    final live = host.instances[printerId]?.bridge.client.last?.model ?? '';
    if (live.isNotEmpty && _models[printerId]?['model'] != live) {
      (_models[printerId] ??= {})['model'] = live;
      _saveModels();
    }
    return live.isNotEmpty ? live : (_models[printerId]?['model'] ?? '');
  }

  /// Everything the slicer page needs for one printer. [machine] picks a nozzle size (it must be
  /// one of this printer's own presets); [model] is used once when the printer's model is unknown.
  Future<Map<String, dynamic>> printerInfo(String printerId, {String? machine, String? model}) async {
    final cfg = host.config.printers.where((p) => p.id == printerId).firstOrNull;
    if (cfg == null) throw SlicerException('Unknown printer.');
    final all = await enginePrinters();
    final models = <String>{for (final p in all) p['model']!}.toList()..sort();
    if (model != null && models.contains(model)) {
      (_models[printerId] ??= {})['engineModel'] = model;
      _models[printerId]!.remove('machine');
      _saveModels();
    }
    final engineModel = _models[printerId]?['engineModel'] ?? matchModel(_modelOf(printerId), models);
    if (engineModel == null) {
      return {'ok': true, 'printer': printerId, 'name': cfg.name, 'known': false, 'models': models};
    }
    final nozzles = [for (final p in all) if (p['model'] == engineModel) p['name']!];
    if (machine != null && nozzles.contains(machine)) {
      (_models[printerId] ??= {})['machine'] = machine;
      _saveModels();
    }
    var chosen = _models[printerId]?['machine'];
    if (chosen == null || !nozzles.contains(chosen)) chosen = defaultNozzle(nozzles);
    final presets = await presetsFor(chosen);
    final processes = [for (final p in presets['processes'] as List) '$p'];
    final values = await resolved(chosen, preferredProcess(processes, '${presets['defaultProcess']}'));
    return {
      'ok': true,
      'printer': printerId,
      'name': cfg.name,
      'known': true,
      'model': engineModel,
      'models': models,
      'machine': chosen,
      'nozzles': nozzles,
      'processes': processes,
      'defaultProcess': preferredProcess(processes, '${presets['defaultProcess']}'),
      'filaments': presets['filaments'],
      'defaultBedType': presets['defaultBedType'],
      'bed': bedOf(values),
      'extruders': (values['nozzle_diameter'] is List) ? (values['nozzle_diameter'] as List).length : 1,
      // one nozzle fed by a 4-spool box (AD5X IFS): 4 colours per print
      'singleNozzleMulti': '${values['single_extruder_multi_material']}' == '1',
    };
  }

  /// Machine for a slice, checked again on the board: only this printer's own presets.
  Future<String> _lockedMachine(String printerId, String? wanted) async {
    final info = await printerInfo(printerId, machine: wanted);
    if (info['known'] != true) throw SlicerException('Pick which Flashforge printer this is first.');
    return info['machine'] as String;
  }

  // ------------------------------------------------------------------ install / remove
  Map<String, dynamic> installState = {'state': 'idle'};
  bool get _busyInstall => installState['state'] == 'downloading' || installState['state'] == 'unpacking';

  Future<bool> supported() async {
    if (engineOverride != null) return true;
    if (!Platform.isLinux) return false;
    try {
      final r = await Process.run('uname', ['-m']);
      return r.stdout.toString().trim() == 'aarch64';
    } catch (_) {
      return false;
    }
  }

  Future<Map<String, dynamic>> install() async {
    if (_busyInstall) return {'ok': true, 'message': 'Already downloading.'};
    if (!await supported()) return {'ok': false, 'message': 'The slicer engine is made for the board (64-bit ARM). It cannot be installed here.'};
    if (repo.isEmpty) return {'ok': false, 'message': 'This build has no download location for the slicer engine.'};
    installState = {'state': 'downloading', 'percent': 0, 'message': 'Getting the slicer engine…'};
    unawaited(_install().catchError((Object e) {
      installState = {'state': 'error', 'message': e is SlicerException ? e.message : 'Download failed: $e'};
      host.log.warn('Slicer engine install failed: $e');
    }));
    return {'ok': true};
  }

  Future<void> _install() async {
    final base = 'https://github.com/$repo/releases/download/latest-image';
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 20);
    final dl = File('$dir/engine-download.tar.gz');
    try {
      Directory(dir).createSync(recursive: true);
      var req = await client.getUrl(Uri.parse('$base/ffbridge-slicer.json'));
      var res = await req.close().timeout(const Duration(seconds: 40));
      if (res.statusCode != 200) {
        await res.drain<void>();
        throw SlicerException(res.statusCode == 404
            ? 'The slicer engine is not published yet. Run the "Build SD card image" workflow on GitHub once, then try again.'
            : 'GitHub answered ${res.statusCode}. Try again later.');
      }
      final meta = jsonDecode(await utf8.decodeStream(res)) as Map<String, dynamic>;
      final total = (meta['size'] as num?)?.toInt() ?? 0;
      final free = await _freeBytes(dir);
      final need = ((meta['unpacked'] as num?)?.toInt() ?? 250000000) + total;
      if (free != null && free < need + 50000000) {
        throw SlicerException('Not enough free space on the SD card (needs ${(need / 1e6).round()} MB, ${(free / 1e6).round()} MB free).');
      }
      req = await client.getUrl(Uri.parse('$base/${meta['file']}'));
      res = await req.close().timeout(const Duration(seconds: 40));
      if (res.statusCode != 200) {
        await res.drain<void>();
        throw SlicerException('Download failed (GitHub answered ${res.statusCode}).');
      }
      final sink = dl.openWrite();
      var got = 0;
      await for (final chunk in res.timeout(const Duration(seconds: 60))) {
        sink.add(chunk);
        got += chunk.length;
        if (total > 0) installState = {'state': 'downloading', 'percent': (got * 100 / total).floor(), 'message': 'Downloading ${(got / 1e6).toStringAsFixed(0)} of ${(total / 1e6).toStringAsFixed(0)} MB…'};
      }
      await sink.close();
      installState = {'state': 'unpacking', 'percent': 100, 'message': 'Checking and unpacking…'};
      final sum = await Process.run('sha256sum', [dl.path]);
      if (sum.stdout.toString().split(' ').first.trim() != meta['sha256']) throw SlicerException('The download was damaged (checksum mismatch). Try again.');
      final fresh = Directory('$dir/engine.new');
      if (fresh.existsSync()) fresh.deleteSync(recursive: true);
      fresh.createSync(recursive: true);
      final tar = await Process.run('tar', ['-xzf', dl.path, '-C', fresh.path]);
      if (tar.exitCode != 0) throw SlicerException('Unpacking failed: ${tar.stderr}');
      // The pack points the engine at <data>/slicer/engine/rt: it has to live exactly there.
      final old = Directory('$dir/engine');
      if (old.existsSync()) old.deleteSync(recursive: true);
      fresh.renameSync(old.path);
      _clearCaches();
      try {
        await enginePrinters();
      } catch (e) {
        throw SlicerException('The engine was installed but does not start on this board: $e');
      }
      installState = {'state': 'done', 'message': 'Slicer engine ${engineVersion} installed.'};
      host.log.info('Slicer engine $engineVersion installed');
    } finally {
      client.close(force: true);
      if (dl.existsSync()) dl.deleteSync();
    }
  }

  static Future<int?> _freeBytes(String path) async {
    try {
      final r = await Process.run('df', ['-B1', '--output=avail', path]);
      return int.tryParse(r.stdout.toString().trim().split('\n').last.trim());
    } catch (_) {
      return null;
    }
  }

  Future<Map<String, dynamic>> remove() async {
    if (engineOverride != null) return {'ok': false, 'message': 'This engine was given on the command line.'};
    if (running != null) return {'ok': false, 'message': 'Wait for the slice to finish.'};
    final d = Directory('$dir/engine');
    if (d.existsSync()) d.deleteSync(recursive: true);
    _clearCaches();
    installState = {'state': 'idle'};
    return {'ok': true, 'message': 'Slicer engine removed.'};
  }

  Future<Map<String, dynamic>> statusJson() async => {
        'enabled': pi.slicerEnabled,
        'installed': installed,
        'engine': engineVersion,
        'supported': await supported(),
        'install': installState,
        'source': slicerSourceUrl,
        'jobs': {for (final e in jobs.entries) '${e.key}': e.value.toJson()},
      };

  // ------------------------------------------------------------------ slicing
  /// The last slice of every plate (plate number -> job). One slice runs at a time.
  final Map<int, SliceJob> jobs = {};
  SliceJob? get running => jobs.values.where((j) => j.running).firstOrNull;
  static int plateOf(Object? v) => (int.tryParse('${v ?? 1}') ?? 1).clamp(1, 99);

  Future<Map<String, dynamic>> startSlice(HttpRequest req) async {
    if (!installed) return {'ok': false, 'message': 'The slicer engine is not installed (Settings → General → Slicer).'};
    if (running != null) return {'ok': false, 'message': 'A slice is already running.'};
    final boundary = req.headers.contentType?.parameters['boundary'];
    if (boundary == null) return {'ok': false, 'message': 'Expected the plate as a file upload.'};
    final plate = plateOf(req.uri.queryParameters['plate']);
    final jd = Directory('$dir/job-$plate');
    if (jd.existsSync()) jd.deleteSync(recursive: true);
    jd.createSync(recursive: true);
    final model = File('${jd.path}/plate.3mf');
    final mp = await parseMultipart(req, boundary, model);
    if (mp.file == null || mp.fileSize == 0) return {'ok': false, 'message': 'No plate received.'};
    Map<String, dynamic> o;
    try {
      o = jsonDecode(mp.fields['options'] ?? '{}') as Map<String, dynamic>;
    } catch (_) {
      return {'ok': false, 'message': 'Bad slice options.'};
    }
    final List<String> args;
    try {
      args = await buildArgs(o, model.path, '${jd.path}/out');
    } on SlicerException catch (e) {
      return {'ok': false, 'message': e.message};
    }
    final thumb = decodePngDataUrl('${o['thumb'] ?? ''}');
    final name = safeName('${o['name'] ?? 'plate'}');
    // Multi-material printers take OrcaSlicer's sliced project (.gcode.3mf): it carries the filament
    // list the colour matching and the printer's material mapping need. Others get plain G-code.
    final c = host.instances['${o['printer']}']?.bridge.client;
    final as3mf = c == null || c.isCreator5 || c.isAD5X;
    final j = jobs[plate] = SliceJob(name: as3mf ? '$name.gcode.3mf' : '$name.gcode', printerId: '${o['printer']}', dir: jd.path, plate: plate);
    host.log.info('Slicing $name for ${o['printer']} (${args.length} options)');
    unawaited(_run(j, args, thumb));
    return {'ok': true, 'job': j.toJson()};
  }

  /// Engine arguments for a slice. Everything the browser sends is checked here.
  Future<List<String>> buildArgs(Map<String, dynamic> o, String model, String outDir) async {
    final printerId = '${o['printer'] ?? ''}';
    final machine = await _lockedMachine(printerId, o['machine']?.toString());
    final presets = await presetsFor(machine);
    final processes = [for (final p in presets['processes'] as List) '$p'];
    final process = '${o['process'] ?? ''}';
    if (!processes.contains(process)) throw SlicerException('That quality preset does not belong to this printer.');
    final allowed = {for (final f in presets['filaments'] as List) '$f'};
    final fils = (o['filaments'] as List? ?? []);
    if (fils.isEmpty || fils.length > 16) throw SlicerException('Pick the filaments first.');
    final colours = <String>[];
    final args = <String>[model, '--printer-preset', machine, '--process-preset', process];
    for (final f in fils) {
      final preset = '${(f as Map)['preset'] ?? ''}';
      if (!allowed.contains(preset)) throw SlicerException('Filament "$preset" is not a profile of this printer.');
      final c = '${f['color'] ?? ''}';
      if (!RegExp(r'^#[0-9A-Fa-f]{6}$').hasMatch(c)) throw SlicerException('Bad filament colour $c.');
      args.addAll(['--filament-preset', preset]);
      colours.add(c.toUpperCase());
    }
    args.addAll(['--filament-colour', colours.join(';')]);
    final keys = await _settingKeys();
    final over = (o['overrides'] as Map? ?? {});
    for (final e in over.entries) {
      final k = '${e.key}';
      final v = '${e.value}';
      if (!keys.contains(k)) throw SlicerException('Unknown setting "$k".');
      if (v.contains('\n') || v.length > 4000) throw SlicerException('Setting "$k" has a value that is not allowed.');
      args.add('--${k.replaceAll('_', '-')}=$v');
    }
    // Prime tower (several filaments): the browser picks a free spot away from the models; the
    // engine's own default can end up partly off the bed when a plate needs a deep tower.
    final tower = o['tower'];
    if (tower is Map && tower['x'] is num && tower['y'] is num) {
      final bed = (await printerInfo(printerId, machine: machine))['bed'] as Map;
      final x = (tower['x'] as num).toDouble(), y = (tower['y'] as num).toDouble();
      if (x < (bed['x0'] as num) || y < (bed['y0'] as num) || x > (bed['x0'] as num) + (bed['w'] as num) || y > (bed['y0'] as num) + (bed['d'] as num)) {
        throw SlicerException('The prime tower position is outside the bed.');
      }
      args.addAll(['--wipe-tower-x=${x.toStringAsFixed(1)}', '--wipe-tower-y=${y.toStringAsFixed(1)}']);
    }
    // Objects stay where they were put in the browser; output: plate_1.gcode + result.json.
    args.addAll(['--arrange', '0', '--slice', '0', '--outputdir', outDir, '--export-3mf', 'plate.gcode.3mf']);
    return args;
  }

  Future<void> _run(SliceJob j, List<String> args, Uint8List? thumb) async {
    Directory('${j.dir}/out').createSync(recursive: true);
    final log = File('${j.dir}/engine.log').openWrite();
    try {
      if (!_held && beforeSlice != null) j.message = 'Pausing the AI to free memory…';
      await _hold();
      if (j.state == 'cancelled') return;
      final p = j.process = await _start(args, j.dir);
      var timedOut = false;
      final timer = Timer(const Duration(minutes: 90), () {
        timedOut = true;
        j.message = 'Took too long, stopped.';
        p.kill();
      });
      final err = p.stderr.transform(utf8.decoder).forEach(log.write);
      await p.stdout.transform(utf8.decoder).transform(const LineSplitter()).forEach((line) {
        log.writeln(line);
        j.onLine(line);
      });
      final code = await p.exitCode;
      timer.cancel();
      await err;
      if (j.state == 'cancelled') return;
      final g = File('${j.dir}/out/plate_1.gcode');
      if (code == -9 && !timedOut) {
        j.fail('The board ran out of memory slicing this plate. Put fewer models on it, use a larger layer height, '
            'or simplify very detailed models, then try again.');
        return;
      }
      if (code != 0 || !g.existsSync()) {
        j.fail(j.error ?? _resultError(j.dir) ?? 'The slicer stopped with an error ($code).');
        return;
      }
      final out = File('${j.dir}/preview.gcode');
      await addThumbnail(g, out, thumb);
      g.deleteSync();
      final proj = File('${j.dir}/out/plate.gcode.3mf');
      if (proj.existsSync() && thumb != null) {
        try {
          zipAddStored(proj, 'Metadata/plate_1.png', thumb);
        } catch (e) {
          host.log.warn('Could not add the plate picture: $e');
        }
      }
      j.project = proj.existsSync() ? proj.path : null;
      j.finish(out.path, gcodeStats(out));
      host.log.info('Sliced ${j.name}: ${j.stats['time']}');
    } catch (e) {
      j.fail('$e');
    } finally {
      j.process = null;
      _release();
      await log.close();
      final m = File('${j.dir}/plate.3mf');
      if (m.existsSync()) m.deleteSync();
    }
  }

  static String? _resultError(String jobDir) {
    try {
      final r = jsonDecode(File('$jobDir/out/result.json').readAsStringSync()) as Map<String, dynamic>;
      final s = '${r['error_string'] ?? ''}';
      return s.isEmpty || s.startsWith('Success') ? null : s;
    } catch (_) {
      return null;
    }
  }

  void cancel() {
    final j = running;
    if (j == null || !j.running) return;
    j.state = 'cancelled';
    j.message = 'Cancelled.';
    j.process?.kill();
  }

  /// Puts the finished G-code into the printer's file list (then the normal print dialog takes over).
  Future<Map<String, dynamic>> send(String printerId, int plate) async {
    final j = jobs[plate];
    if (j == null || j.state != 'done' || j.gcode == null) return {'ok': false, 'message': 'Slice the plate first.'};
    final b = host.instances[printerId]?.bridge;
    if (b == null) return {'ok': false, 'message': 'That printer is not running.'};
    if (printerId != j.printerId) return {'ok': false, 'message': 'This plate was sliced for another printer.'};
    final src = j.name.endsWith('.3mf') ? j.project : j.gcode;
    if (src == null || !File(src).existsSync()) return {'ok': false, 'message': 'The sliced file is missing. Slice again.'};
    final dest = b.files.fileFor('gcodes', j.name);
    dest.parent.createSync(recursive: true);
    if (dest.existsSync()) dest.deleteSync();
    await File(src).copy(dest.path);
    await b.files.scanMetadata(j.name);
    b.emitRaw('notify_filelist_changed', [
      {'action': 'create_file', 'item': {...b.files.itemInfo('gcodes', j.name), 'root': 'gcodes', 'path': j.name}}
    ]);
    return {'ok': true, 'file': j.name};
  }

  // ------------------------------------------------------------------ HTTP
  Future<bool> handle(HttpRequest req, List<String> seg, Future<void> Function(HttpRequest, Object?, {int status}) json) async {
    if (seg.isEmpty || seg[0] != 'slicer') return false;
    final m = req.method;
    final q = req.uri.queryParameters;
    final route = '$m ${seg.skip(1).join('/')}';
    Future<Map<String, dynamic>> body() async {
      final s = await utf8.decodeStream(req);
      return s.trim().isEmpty ? {} : Map<String, dynamic>.from(jsonDecode(s) as Map);
    }

    try {
      switch (route) {
        case 'GET ':
          await json(req, {'ok': true, ...await statusJson()});
        case 'POST settings':
          final b = await body();
          if (b['enabled'] is bool) pi.slicerEnabled = b['enabled'];
          pi.save();
          await json(req, {'ok': true, ...await statusJson()});
        case 'POST install':
          await json(req, await install());
        case 'POST remove':
          await json(req, await remove());
        case 'GET printer':
          if (!installed) return await json(req, {'ok': false, 'message': 'The slicer engine is not installed.'}).then((_) => true);
          await json(req, await printerInfo(q['id'] ?? '', machine: q['machine'], model: q['model']));
        case 'GET resolved':
          final machine = await _lockedMachine(q['id'] ?? '', q['machine']);
          await json(req, {'ok': true, 'values': await resolved(machine, q['process'] ?? '')});
        case 'GET schema':
          await json(req, {'ok': true, 'settings': await schema()});
        case 'POST slice':
          await json(req, await startSlice(req));
        case 'GET job':
          await json(req, {'ok': true, 'job': jobs[plateOf(q['plate'])]?.toJson(), 'running': running?.plate});
        case 'POST job/cancel':
          cancel();
          await json(req, {'ok': true});
        case 'POST send':
          final b = await body();
          await json(req, await send('${b['printer'] ?? ''}', plateOf(b['plate'])));
        case 'GET gcode':
          final job = jobs[plateOf(q['plate'])];
          final g = job?.gcode;
          if (job == null || g == null || !File(g).existsSync()) return await json(req, {'ok': false, 'message': 'Nothing sliced yet.'}, status: 404).then((_) => true);
          req.response.headers
            ..contentType = ContentType('text', 'plain', charset: 'utf-8')
            ..set('Cache-Control', 'no-store');
          var file = g;
          if (q['download'] == '3mf' && job.project != null) {
            file = job.project!;
            req.response.headers.set('Content-Disposition', 'attachment; filename="${job.name.replaceAll('"', '')}"');
          } else if (q.containsKey('download')) {
            req.response.headers.set('Content-Disposition', 'attachment; filename="${job.name.replaceAll(RegExp(r'\.gcode\.3mf$'), '.gcode').replaceAll('"', '')}"');
          }
          await req.response.addStream(File(file).openRead());
          await req.response.close();
        default:
          await json(req, {'ok': false, 'message': 'Not found'}, status: 404);
      }
    } on SlicerException catch (e) {
      await json(req, {'ok': false, 'message': e.message});
    }
    return true;
  }
}

class SlicerException implements Exception {
  final String message;
  SlicerException(this.message);
  @override
  String toString() => message;
}

class SliceJob {
  final String name, printerId, dir;
  final DateTime started = DateTime.now();
  DateTime? finished;
  String state = 'slicing'; // slicing | done | error | cancelled
  int percent = 0;
  String message = 'Starting the slicer…';
  String? error;
  String? gcode, project;
  Map<String, dynamic> stats = {};
  final List<String> warnings = [];
  Process? process;

  final int plate;
  SliceJob({required this.name, required this.printerId, required this.dir, this.plate = 1});
  bool get running => state == 'slicing';

  void onLine(String line) {
    const tag = '[[SLICER_EVENT]]';
    final i = line.indexOf(tag);
    if (i < 0) return;
    Map<String, dynamic> e;
    try {
      e = jsonDecode(line.substring(i + tag.length).trim()) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    final ev = '${e['event'] ?? ''}';
    if (ev == 'progress') {
      final p = (e['percent'] as num?)?.toInt();
      if (p != null && p >= percent) percent = p.clamp(0, 99);
      final msg = '${e['message'] ?? ''}';
      if (msg.isNotEmpty) message = msg;
    } else if (ev == 'slice_warning') {
      final w = friendlyWarning('${e['message'] ?? ''}', '${e['tag'] ?? ''}');
      if (!warnings.contains(w)) warnings.add(w);
    } else if (ev.contains('error') || '${e['severity']}' == 'error') {
      error ??= '${e['message'] ?? 'Slicing failed.'}';
    }
  }

  void finish(String path, Map<String, dynamic> s) {
    gcode = path;
    stats = s;
    state = 'done';
    percent = 100;
    message = 'Done';
    finished = DateTime.now();
  }

  void fail(String why) {
    if (state == 'cancelled') return;
    state = 'error';
    error = why;
    message = why;
    finished = DateTime.now();
  }

  Map<String, dynamic> toJson() => {
        'name': name,
        'plate': plate,
        'printer': printerId,
        'state': state,
        'percent': percent,
        'message': message,
        'error': error,
        'warnings': warnings,
        'stats': stats,
        'seconds': (finished ?? DateTime.now()).difference(started).inSeconds,
        'hasProject': project != null,
      };
}

// ------------------------------------------------------------------ pure helpers (tested)

/// At most this many cores slice (A733: its 2 fast Cortex-A76 cores + 1 Cortex-A55).
const maxSlicerCores = 3;

/// The [max] cores with the highest capacity (fast cores first; same speed: lower number first).
List<int> pickCpus(Map<int, int> capacity, int max) {
  final ids = capacity.keys.toList()..sort((a, b) => capacity[b] != capacity[a] ? capacity[b]!.compareTo(capacity[a]!) : a.compareTo(b));
  return (ids.take(max).toList()..sort());
}

/// "Creator 5 Pro" (what the printer reports) -> "Flashforge Creator 5 Pro" (the engine's model).
String? matchModel(String printerModel, List<String> engineModels) {
  String norm(String s) => s.toLowerCase().replaceAll('flashforge', '').replaceAll(RegExp(r'[^a-z0-9]'), '');
  final want = norm(printerModel);
  if (want.isEmpty) return null;
  for (final m in engineModels) {
    if (norm(m) == want) return m;
  }
  // The printer said a bit more or less ("Adventurer 5M Pro" vs "5M Pro"): longest name that fits.
  String? best;
  for (final m in engineModels) {
    final n = norm(m);
    if (n.isEmpty) continue;
    if ((want.endsWith(n) || n.endsWith(want)) && (best == null || n.length > norm(best).length)) best = m;
  }
  return best;
}

const _safeTypes = {'float', 'int', 'bool', 'enum', 'percent', 'float_or_percent'};
bool overridable(Map<String, dynamic> s) {
  final k = '${s['key']}';
  return _safeTypes.contains(s['type']) && s['vector'] != true && !k.contains('gcode') && !k.contains('post_process') && !k.contains('filename');
}

String defaultNozzle(List<String> names) =>
    names.firstWhere((n) => RegExp(r'\b0\.4\b').hasMatch(n) && !n.contains('HF'), orElse: () => names.isEmpty ? '' : names.first);

String preferredProcess(List<String> processes, String engineDefault) {
  final std = processes.where((p) => p.startsWith('0.20mm Standard')).firstOrNull;
  return std ?? (processes.contains(engineDefault) ? engineDefault : (processes.isEmpty ? '' : processes.first));
}

/// Only the printer's own Flashforge filament profiles (no Bambu / other brands' "@System" ones).
List<String> flashforgeFilaments(List<String> all) {
  final own = all.where((f) => f.contains('@FF') || f.contains('@Flashforge')).toList();
  if (own.isNotEmpty) return own;
  final ff = all.where((f) => f.toLowerCase().startsWith('flashforge')).toList();
  return ff.isNotEmpty ? ff : all;
}

/// Bed size from the profile: {x0, y0, w, d, h}.
Map<String, num> bedOf(Map<String, dynamic> v) {
  final pts = (v['printable_area'] is List ? v['printable_area'] as List : const ['0x0', '220x0', '220x220', '0x220'])
      .map((p) => '$p'.split('x').map((n) => double.tryParse(n) ?? 0).toList())
      .where((p) => p.length == 2)
      .toList();
  var x0 = double.infinity, y0 = double.infinity, x1 = -double.infinity, y1 = -double.infinity;
  for (final p in pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  if (pts.isEmpty) x0 = y0 = 0;
  return {'x0': x0, 'y0': y0, 'w': pts.isEmpty ? 220 : x1 - x0, 'd': pts.isEmpty ? 220 : y1 - y0, 'h': double.tryParse('${v['printable_height'] ?? ''}') ?? 250};
}

String safeName(String s) {
  var n = s.replaceAll(RegExp(r'\.(3mf|stl|obj|step|stp|gcode)$', caseSensitive: false), '');
  n = n.replaceAll(RegExp(r'[^A-Za-z0-9 _.()+-]'), '_').trim();
  if (n.length > 60) n = n.substring(0, 60);
  return n.isEmpty || n.startsWith('.') ? 'plate' : n;
}

Uint8List? decodePngDataUrl(String s) {
  const pre = 'data:image/png;base64,';
  if (!s.startsWith(pre) || s.length > 400000) return null;
  try {
    final b = base64.decode(s.substring(pre.length));
    return (b.length > 24 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) ? b : null;
  } catch (_) {
    return null;
  }
}

/// Copies [src] to [dst] with a PrusaSlicer-style thumbnail block after the header, so the
/// file list, the print dialog and the printer show a picture of the plate.
Future<void> addThumbnail(File src, File dst, Uint8List? png) async {
  if (png == null) {
    await src.copy(dst.path);
    return;
  }
  final w = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19];
  final h = (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23];
  final b64 = base64.encode(png);
  final block = StringBuffer('\n; THUMBNAIL_BLOCK_START\n;\n; thumbnail begin ${w}x$h ${b64.length}\n');
  for (var i = 0; i < b64.length; i += 78) {
    block.writeln('; ${b64.substring(i, i + 78 > b64.length ? b64.length : i + 78)}');
  }
  block.write('; thumbnail end\n;\n; THUMBNAIL_BLOCK_END\n');
  final raf = await src.open();
  final head = await raf.read(65536);
  await raf.close();
  final text = latin1.decode(head);
  const marker = '; HEADER_BLOCK_END';
  var at = text.indexOf(marker);
  at = at < 0 ? 0 : text.indexOf('\n', at) + 1;
  final out = dst.openWrite();
  out.add(head.sublist(0, at));
  out.add(latin1.encode(block.toString()));
  out.add(head.sublist(at));
  await out.addStream(src.openRead(head.length));
  await out.close();
}

/// Print time, filament per extruder and layer count from the G-code's closing comments.
Map<String, dynamic> gcodeStats(File f) {
  final len = f.lengthSync();
  final raf = f.openSync();
  final tailStart = len > 300000 ? len - 300000 : 0;
  raf.setPositionSync(tailStart);
  final tail = latin1.decode(raf.readSync(len - tailStart));
  raf.setPositionSync(0);
  final head = latin1.decode(raf.readSync(len < 4000 ? len : 4000));
  raf.closeSync();
  String? val(String text, String key) {
    final m = RegExp('^; ${RegExp.escape(key)} = (.*)\$', multiLine: true).firstMatch(text);
    return m?.group(1)?.trim();
  }

  List<double> nums(String? s) => s == null ? [] : s.split(',').map((x) => double.tryParse(x.trim()) ?? 0).toList();
  final layers = RegExp(r'^; total layer number: (\d+)', multiLine: true).firstMatch(head)?.group(1);
  return {
    'time': val(tail, 'estimated printing time (normal mode)') ?? '',
    'grams': nums(val(tail, 'filament used [g]')),
    'meters': nums(val(tail, 'filament used [mm]')).map((mm) => (mm / 10).round() / 100).toList(),
    'totalGrams': double.tryParse(val(tail, 'total filament used [g]') ?? '') ?? 0,
    'changes': int.tryParse(val(tail, 'total filament change') ?? '') ?? 0,
    'layers': int.tryParse(layers ?? '') ?? 0,
    'bytes': len,
  };
}

String friendlyWarning(String msg, String tag) {
  const known = {
    'bed_temperature_too_high_than_filament': 'The bed is hotter than one of the filaments likes (check the plate type).',
    'filament_unprintable': 'A filament cannot be printed with this printer / nozzle.',
    'toolpath_outside': 'Part of the print is outside the printable area.',
    'toolpath_conflict': 'Some paths collide with each other or with the prime tower.',
  };
  return known[tag] ?? known[msg] ?? msg.replaceAll('_', ' ');
}

/// A 10 mm cube as binary STL (the engine needs a model to report the resolved settings).
Uint8List probeStl() {
  final v = [for (final x in [0.0, 10.0]) for (final y in [0.0, 10.0]) for (final z in [0.0, 10.0]) [x + 100, y + 100, z]];
  const f = [[0, 2, 3], [0, 3, 1], [4, 5, 7], [4, 7, 6], [0, 1, 5], [0, 5, 4], [2, 6, 7], [2, 7, 3], [0, 4, 6], [0, 6, 2], [1, 3, 7], [1, 7, 5]];
  final b = ByteData(84 + 50 * f.length);
  b.setUint32(80, f.length, Endian.little);
  var o = 84;
  for (final t in f) {
    o += 12;
    for (final i in t) {
      for (final c in v[i]) {
        b.setFloat32(o, c, Endian.little);
        o += 4;
      }
    }
    o += 2;
  }
  return b.buffer.asUint8List();
}

// ------------------------------------------------------------------ zip: add one stored entry
final _crcTable = List<int>.generate(256, (n) {
  var c = n;
  for (var k = 0; k < 8; k++) {
    c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
  }
  return c;
});
int crc32(List<int> data) {
  var c = 0xFFFFFFFF;
  for (final b in data) {
    c = _crcTable[(c ^ b) & 0xFF] ^ (c >> 8);
  }
  return c ^ 0xFFFFFFFF;
}

/// Appends [name] (uncompressed) to the zip file [f]: new entry where the central directory was,
/// then the old directory plus the new record. Replaces nothing; the name must be new.
void zipAddStored(File f, String name, Uint8List data) {
  final raf = f.openSync(mode: FileMode.append);
  try {
    final len = raf.lengthSync();
    final tailLen = len < 66000 ? len : 66000;
    raf.setPositionSync(len - tailLen);
    final tail = raf.readSync(tailLen);
    var e = -1;
    for (var i = tail.length - 22; i >= 0; i--) {
      if (tail[i] == 0x50 && tail[i + 1] == 0x4b && tail[i + 2] == 5 && tail[i + 3] == 6) {
        e = i;
        break;
      }
    }
    if (e < 0) throw const FormatException('not a zip file');
    final eocd = ByteData.sublistView(tail, e);
    final count = eocd.getUint16(10, Endian.little);
    final cdSize = eocd.getUint32(12, Endian.little);
    final cdOff = eocd.getUint32(16, Endian.little);
    raf.setPositionSync(cdOff);
    final cd = raf.readSync(cdSize);
    final n = utf8.encode(name);
    final crc = crc32(data);
    final local = ByteData(30)
      ..setUint32(0, 0x04034b50, Endian.little)
      ..setUint16(4, 20, Endian.little)
      ..setUint32(14, crc, Endian.little)
      ..setUint32(18, data.length, Endian.little)
      ..setUint32(22, data.length, Endian.little)
      ..setUint16(26, n.length, Endian.little);
    final central = ByteData(46)
      ..setUint32(0, 0x02014b50, Endian.little)
      ..setUint16(4, 20, Endian.little)
      ..setUint16(6, 20, Endian.little)
      ..setUint32(16, crc, Endian.little)
      ..setUint32(20, data.length, Endian.little)
      ..setUint32(24, data.length, Endian.little)
      ..setUint16(28, n.length, Endian.little)
      ..setUint32(42, cdOff, Endian.little);
    final newCdOff = cdOff + 30 + n.length + data.length;
    final newCdSize = cdSize + 46 + n.length;
    final end = ByteData(22)
      ..setUint32(0, 0x06054b50, Endian.little)
      ..setUint16(8, count + 1, Endian.little)
      ..setUint16(10, count + 1, Endian.little)
      ..setUint32(12, newCdSize, Endian.little)
      ..setUint32(16, newCdOff, Endian.little);
    raf.truncateSync(cdOff);
    raf.setPositionSync(cdOff);
    raf
      ..writeFromSync(local.buffer.asUint8List())
      ..writeFromSync(n)
      ..writeFromSync(data)
      ..writeFromSync(cd)
      ..writeFromSync(central.buffer.asUint8List())
      ..writeFromSync(n)
      ..writeFromSync(end.buffer.asUint8List());
  } finally {
    raf.closeSync();
  }
}
