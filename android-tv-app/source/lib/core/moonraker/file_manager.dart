// Moonraker-style file manager. Local "gcodes" storage is merged with the list of
// files reported by the printer itself (/gcodeList), so jobs uploaded by other tools
// (FlashPrint, Orca's native FlashForge host, USB) are visible and printable too.
import 'dart:convert';
import 'dart:io';

import 'metadata.dart';

class RpcError implements Exception {
  final int code;
  final String message;
  RpcError(this.code, this.message);
  @override
  String toString() => message;
}

class FileManager {
  final String dataDir;
  late final Directory gcodes = Directory('$dataDir/gcodes');
  late final Directory config = Directory('$dataDir/config');
  late final Directory logs = Directory('$dataDir/logs');
  late final File _metaFile = File('$dataDir/metadata_cache.json');
  Map<String, dynamic> _metaCache = {};

  /// Files that exist on the printer: name -> first seen (epoch seconds).
  final Map<String, double> printerFiles = {};
  final Map<String, int> printerFileTimes = {}; // printingTime (s) from AD5X detail lists

  FileManager(this.dataDir) {
    for (final d in [gcodes, Directory('${gcodes.path}/.thumbs'), config, logs]) {
      d.createSync(recursive: true);
    }
    try {
      _metaCache = Map<String, dynamic>.from(jsonDecode(_metaFile.readAsStringSync()));
    } catch (_) {}
  }

  void _saveMeta() {
    try {
      _metaFile.writeAsStringSync(jsonEncode(_metaCache));
    } catch (_) {}
  }

  Directory rootDir(String root) {
    switch (root) {
      case 'gcodes':
        return gcodes;
      case 'config':
        return config;
      case 'logs':
        return logs;
    }
    throw RpcError(400, 'Invalid root: $root');
  }

  List<String> get roots => ['gcodes', 'config', 'logs'];

  /// Splits "gcodes/sub/file.gcode" into (root, relative).
  (String, String) splitPath(String path) {
    var p = path.replaceAll('\\', '/');
    while (p.startsWith('/')) {
      p = p.substring(1);
    }
    final i = p.indexOf('/');
    if (i < 0) return (p, '');
    return (p.substring(0, i), p.substring(i + 1));
  }

  String safeRel(String rel) {
    final parts = rel.replaceAll('\\', '/').split('/').where((e) => e.isNotEmpty && e != '.').toList();
    if (parts.contains('..')) throw RpcError(403, 'Invalid path');
    return parts.join('/');
  }

  File fileFor(String root, String rel) {
    if (root == 'gcodes') rel = resolve(rel);
    return File('${rootDir(root).path}/${safeRel(rel)}');
  }

  // Mainsail only lists .gcode/.g/.gco/.ufp/.nc files, but FlashForge printers mostly hold
  // ".gcode.3mf" jobs (OrcaSlicer / FlashPrint). Those are shown under a "<name>.3mf.gcode"
  // alias and mapped back to the real name whenever the alias is used.
  static String displayName(String real) {
    final l = real.toLowerCase();
    if (l.endsWith('.gcode.3mf')) return '${real.substring(0, real.length - 10)}.3mf.gcode';
    if (l.endsWith('.3mf')) return '${real.substring(0, real.length - 4)}.3mf.gcode';
    return real;
  }

  /// Maps a (possibly aliased) gcodes-relative name to the real file name.
  String resolve(String name) {
    if (!name.toLowerCase().endsWith('.3mf.gcode')) return name;
    final direct = File('${gcodes.path}/${safeRel(name)}');
    if (direct.existsSync()) return name;
    final base = name.substring(0, name.length - 10);
    for (final cand in ['$base.gcode.3mf', '$base.3mf']) {
      if (printerFiles.containsKey(cand) || File('${gcodes.path}/${safeRel(cand)}').existsSync()) return cand;
    }
    return name;
  }

  static double _mtime(FileSystemEntity e) => e.statSync().modified.millisecondsSinceEpoch / 1000.0;

  Map<String, dynamic> diskUsage() {
    // dart:io has no statvfs; report the printer-side free space via bridge if known.
    return {'total': 32 * 1024 * 1024 * 1024, 'used': _dirSize(gcodes), 'free': 16 * 1024 * 1024 * 1024};
  }

  int _dirSize(Directory d) {
    var s = 0;
    try {
      for (final e in d.listSync(recursive: true)) {
        if (e is File) s += e.lengthSync();
      }
    } catch (_) {}
    return s;
  }

  bool isLocal(String filename) => fileFor('gcodes', filename).existsSync();

  Map<String, dynamic> getDirectory(String path, {bool extended = false}) {
    final (root, rel) = splitPath(path.isEmpty ? 'gcodes' : path);
    final dir = Directory('${rootDir(root).path}/${safeRel(rel)}');
    if (!dir.existsSync()) throw RpcError(404, 'Directory does not exist ($path)');
    final dirs = <Map<String, dynamic>>[];
    final files = <Map<String, dynamic>>[];
    final seen = <String>{};
    for (final e in dir.listSync()) {
      final name = e.uri.pathSegments.where((s) => s.isNotEmpty).last;
      if (name.startsWith('.')) continue;
      if (e is Directory) {
        dirs.add({'dirname': name, 'modified': _mtime(e), 'size': 4096, 'permissions': 'rw'});
      } else if (e is File) {
        seen.add(name);
        final entry = <String, dynamic>{'filename': displayName(name), 'modified': _mtime(e), 'size': e.lengthSync(), 'permissions': root == 'gcodes' ? 'rw' : 'r'};
        if (extended && root == 'gcodes') entry.addAll(metadataFor(rel.isEmpty ? name : '$rel/$name') ?? {});
        files.add(entry);
      }
    }
    if (root == 'gcodes' && rel.isEmpty) {
      for (final pf in printerFiles.entries) {
        if (seen.contains(pf.key)) continue;
        final entry = <String, dynamic>{'filename': displayName(pf.key), 'modified': pf.value, 'size': 0, 'permissions': 'r'};
        if (extended) entry.addAll(metadataFor(pf.key) ?? {});
        files.add(entry);
      }
    }
    return {
      'dirs': dirs,
      'files': files,
      'disk_usage': diskUsage(),
      'root_info': {'name': root, 'permissions': root == 'gcodes' ? 'rw' : 'r'},
    };
  }

  List<Map<String, dynamic>> listFiles(String root) {
    final out = <Map<String, dynamic>>[];
    final base = rootDir(root);
    final seen = <String>{};
    for (final e in base.listSync(recursive: true)) {
      if (e is! File) continue;
      final rel = e.path.substring(base.path.length + 1).replaceAll('\\', '/');
      if (rel.split('/').any((s) => s.startsWith('.'))) continue;
      seen.add(rel);
      out.add({'path': displayName(rel), 'modified': _mtime(e), 'size': e.lengthSync(), 'permissions': root == 'gcodes' ? 'rw' : 'r'});
    }
    if (root == 'gcodes') {
      for (final pf in printerFiles.entries) {
        if (!seen.contains(pf.key)) out.add({'path': displayName(pf.key), 'modified': pf.value, 'size': 0, 'permissions': 'r'});
      }
    }
    return out;
  }

  /// Moonraker-format metadata for a gcodes-relative filename (null if unknown).
  Map<String, dynamic>? metadataFor(String requested) {
    final filename = resolve(requested);
    final f = fileFor('gcodes', filename);
    if (!f.existsSync()) {
      if (!printerFiles.containsKey(filename)) return null;
      final m = <String, dynamic>{
        'filename': displayName(filename),
        'size': 0,
        'modified': printerFiles[filename],
        'print_start_time': null,
        'job_id': null,
      };
      final pt = printerFileTimes[filename];
      if (pt != null && pt > 0) {
        m['estimated_time'] = pt;
      } else {
        // Orca/FlashPrint names often end in the print time, e.g. "_1d5h52m" or "_53m29s"
        final t = RegExp(r'_(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:\.gcode)?(?:\.3mf)?$', caseSensitive: false).firstMatch(filename);
        if (t != null && t.group(0)!.length > 1) {
          int g(int i) => int.tryParse(t.group(i) ?? '') ?? 0;
          final secs = g(1) * 86400 + g(2) * 3600 + g(3) * 60 + g(4);
          if (secs > 0) m['estimated_time'] = secs;
        }
        final mat = RegExp(r'_(PLA|PETG|ABS|ASA|TPU|PA|PC|PLA-CF|PETG-CF|PA-CF|SILK|PVA|HIPS)_', caseSensitive: false).firstMatch(filename);
        if (mat != null) m['filament_type'] = mat.group(1)!.toUpperCase();
      }
      final t = File('${gcodes.path}/.thumbs/${_thumbBase(filename)}-printer.png');
      if (t.existsSync()) {
        m['thumbnails'] = withSmall([
          {'width': 300, 'height': 300, 'size': t.lengthSync(), 'relative_path': '.thumbs/${_thumbBase(filename)}-printer.png'}
        ]);
      }
      return m;
    }
    final key = filename;
    final mt = _mtime(f);
    final cached = _metaCache[key];
    if (cached is Map && cached['modified'] == mt) return {...Map<String, dynamic>.from(cached), 'filename': displayName(filename)};
    return {'filename': filename, 'size': f.lengthSync(), 'modified': mt};
  }

  /// Mainsail's file list wants a 32-64 px thumbnail; if the slicer only embedded a
  /// large one, advertise it a second time as a small one (the browser scales it).
  static List<Map<String, dynamic>> withSmall(List<Map<String, dynamic>> thumbs) {
    if (thumbs.isEmpty || thumbs.any((t) => (t['width'] as int) <= 64 && (t['width'] as int) >= 30)) return thumbs;
    final big = thumbs.reduce((a, b) => (a['width'] as int) >= (b['width'] as int) ? a : b);
    return [{...big, 'width': 48, 'height': 48}, ...thumbs];
  }

  String _thumbBase(String filename) {
    final n = filename.split('/').last;
    final dot = n.lastIndexOf('.');
    return dot > 0 ? n.substring(0, dot) : n;
  }

  /// Scans a local file, writes thumbnails and caches metadata. Returns tool count.
  Future<int> scanMetadata(String filename) async {
    final f = fileFor('gcodes', filename);
    if (!f.existsSync()) return 0;
    final lower = filename.toLowerCase();
    final md = lower.endsWith('.3mf') ? await extract3mfMetadata(f) : await extractGcodeMetadata(f);
    final dirRel = filename.contains('/') ? filename.substring(0, filename.lastIndexOf('/')) : '';
    final thumbDir = Directory('${gcodes.path}/${dirRel.isEmpty ? '' : '$dirRel/'}.thumbs')..createSync(recursive: true);
    final thumbs = <Map<String, dynamic>>[];
    final base = _thumbBase(filename);
    for (final t in md.thumbs) {
      final name = '$base-${t.width}x${t.height}.png';
      await File('${thumbDir.path}/$name').writeAsBytes(t.png);
      thumbs.add({'width': t.width, 'height': t.height, 'size': t.png.length, 'relative_path': '.thumbs/$name'});
    }
    final meta = <String, dynamic>{
      ...md.meta,
      'filename': filename,
      'size': f.lengthSync(),
      'modified': _mtime(f),
      'uuid': '${filename.hashCode}-${f.lengthSync()}',
      'tool_count': md.toolCount,
      'print_start_time': null,
      'job_id': null,
      if (thumbs.isNotEmpty) 'thumbnails': withSmall(thumbs),
    };
    _metaCache[filename] = meta;
    _saveMeta();
    return md.toolCount;
  }

  int toolCount(String filename) => (metadataFor(filename)?['tool_count'] as int?) ?? 0;

  void setPrinterThumb(String filename, List<int> png) {
    File('${gcodes.path}/.thumbs/${_thumbBase(filename)}-printer.png').writeAsBytesSync(png);
  }

  bool hasPrinterThumb(String filename) => File('${gcodes.path}/.thumbs/${_thumbBase(filename)}-printer.png').existsSync();

  void updatePrinterFiles(List<String> names, Map<String, int> times) {
    final now = DateTime.now().millisecondsSinceEpoch / 1000.0;
    for (final n in names) {
      printerFiles.putIfAbsent(n, () => now);
    }
    printerFiles.removeWhere((k, _) => !names.contains(k));
    printerFileTimes
      ..clear()
      ..addAll(times);
  }

  Map<String, dynamic> itemInfo(String root, String rel) {
    final f = fileFor(root, rel);
    return {'path': rel, 'root': root, 'size': f.existsSync() ? f.lengthSync() : 0, 'modified': f.existsSync() ? _mtime(f) : 0, 'permissions': 'rw'};
  }

  void deleteFile(String path) {
    var (root, rel) = splitPath(path);
    if (root != 'gcodes') throw RpcError(403, 'Read-only root');
    rel = resolve(rel);
    final f = fileFor(root, rel);
    if (!f.existsSync()) {
      if (printerFiles.containsKey(rel)) {
        throw RpcError(400, 'This file is stored on the printer; the FlashForge LAN API cannot delete it. Delete it on the printer screen.');
      }
      throw RpcError(404, 'File does not exist');
    }
    f.deleteSync();
    _metaCache.remove(rel);
    _saveMeta();
    final base = _thumbBase(rel);
    final td = Directory('${f.parent.path}/.thumbs');
    if (td.existsSync()) {
      for (final t in td.listSync()) {
        if (t.uri.pathSegments.last.startsWith('$base-')) t.deleteSync();
      }
    }
  }

  void createDir(String path) {
    final (root, rel) = splitPath(path);
    if (root != 'gcodes') throw RpcError(403, 'Read-only root');
    Directory('${gcodes.path}/${safeRel(rel)}').createSync(recursive: true);
  }

  void deleteDir(String path, {bool force = false}) {
    final (root, rel) = splitPath(path);
    if (root != 'gcodes' || safeRel(rel).isEmpty) throw RpcError(403, 'Cannot delete this directory');
    final d = Directory('${gcodes.path}/${safeRel(rel)}');
    if (!d.existsSync()) throw RpcError(404, 'Directory does not exist');
    d.deleteSync(recursive: force);
  }

  void move(String source, String dest, {bool copy = false}) {
    final (sr, srel) = splitPath(source);
    final (dr, drel) = splitPath(dest);
    if (dr != 'gcodes') throw RpcError(403, 'Read-only root');
    final src = '${rootDir(sr).path}/${safeRel(srel)}';
    var dst = '${rootDir(dr).path}/${safeRel(drel)}';
    if (Directory(dst).existsSync()) dst = '$dst/${src.split('/').last}';
    if (FileSystemEntity.isDirectorySync(src)) {
      if (copy) throw RpcError(400, 'Copying directories is not supported');
      Directory(src).renameSync(dst);
    } else {
      final f = File(src);
      if (!f.existsSync()) throw RpcError(404, 'Source does not exist');
      File(dst).parent.createSync(recursive: true);
      copy ? f.copySync(dst) : f.renameSync(dst);
      final newRel = dst.substring(gcodes.path.length + 1);
      if (!copy) {
        _metaCache.remove(safeRel(srel));
        _saveMeta();
      }
      scanMetadata(newRel);
    }
  }
}
