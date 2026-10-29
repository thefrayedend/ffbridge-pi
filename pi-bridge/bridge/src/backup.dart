// Settings backup / restore.
//
// A backup is one JSON file with the bridge's settings: printers (incl. pairing codes),
// integrations, AI settings, the page password, and each printer's print history and
// Mainsail settings. Print files and logs are not included.
//
// Besides "Download backup" on the page, the bridge keeps an up-to-date copy on the SD
// card's FFBRIDGE drive. A fresh SD card that has this file on its FFBRIDGE drive restores
// it by itself on first start (only when no printer is set up yet).
import 'dart:async';
import 'dart:convert';
import 'dart:io';

const backupFileName = 'ffbridge-backup.json';
const _format = 'ffbridge-backup';

class Backup {
  final String dataDir;
  final String version;
  Backup(this.dataDir, this.version);

  static bool _wanted(String rel) {
    if (rel == 'ffbridge.json' || rel == 'pi.json') return true;
    final p = rel.split('/');
    if (p.length < 3 || p[0] != 'printers') return false;
    if (p.length == 3 && p[2] == 'history.json') return true;
    // Mainsail settings live in the printer's config folder (small text files).
    return p[2] == 'config' && !rel.endsWith('.log') && !p.contains('logs');
  }

  /// All settings as a map {relative path: file text}.
  Map<String, String> collect() {
    final out = <String, String>{};
    final base = Directory(dataDir);
    if (!base.existsSync()) return out;
    for (final e in base.listSync(recursive: true, followLinks: false)) {
      if (e is! File) continue;
      final rel = e.path.substring(base.path.length + 1).replaceAll('\\', '/');
      if (!_wanted(rel)) continue;
      if (e.lengthSync() > 2 * 1024 * 1024) continue; // never pull in anything big
      try {
        out[rel] = e.readAsStringSync();
      } catch (_) {/* binary or unreadable: skip */}
    }
    return out;
  }

  int printerCount() {
    try {
      final j = jsonDecode(File('$dataDir/ffbridge.json').readAsStringSync());
      return ((j as Map)['printers'] as List?)?.length ?? 0;
    } catch (_) {
      return 0;
    }
  }

  Map<String, dynamic> build() => {
        'format': _format,
        'formatVersion': 1,
        'created': DateTime.now().toIso8601String(),
        'bridgeVersion': version,
        'files': collect(),
      };

  /// Checks a backup and returns a human message when it can't be used.
  static String? validate(Object? j) {
    if (j is! Map || j['format'] != _format) return 'This is not a FlashForge Bridge backup file.';
    final files = j['files'];
    if (files is! Map || !files.containsKey('ffbridge.json')) return 'The backup file is incomplete.';
    for (final k in files.keys) {
      final rel = k.toString();
      if (rel.contains('..') || rel.startsWith('/') || rel.contains('\\') || !_wanted(rel)) return 'The backup file contains an unexpected entry ($rel).';
      if (files[k] is! String) return 'The backup file is damaged.';
    }
    return null;
  }

  /// Writes the backup's files into the data folder (replacing current settings).
  void restore(Map j) {
    final files = (j['files'] as Map).cast<String, String>();
    files.forEach((rel, text) {
      final f = File('$dataDir/$rel');
      f.parent.createSync(recursive: true);
      final tmp = File('${f.path}.restore');
      tmp.writeAsStringSync(text, flush: true);
      tmp.renameSync(f.path);
    });
  }

  /// On first start of a fresh card: restore from the FFBRIDGE drive if nothing is set up yet.
  String? restoreFromBootDrive(String bootDir) {
    if (bootDir.isEmpty) return null;
    final f = File('$bootDir/$backupFileName');
    if (!f.existsSync() || printerCount() > 0) return null;
    try {
      final j = jsonDecode(f.readAsStringSync());
      final err = validate(j);
      if (err != null) return 'Backup on the SD card was not restored: $err';
      final cfg = jsonDecode(((j as Map)['files'] as Map)['ffbridge.json'] as String);
      if (((cfg as Map)['printers'] as List? ?? const []).isEmpty) return null; // nothing worth restoring
      restore(j);
      return 'Settings restored from $backupFileName on the SD card (made ${j['created']}).';
    } catch (e) {
      return 'Backup on the SD card could not be read: $e';
    }
  }

  // ------------------------------------------------------------------ automatic copy on the SD card
  Timer? _timer;
  String _lastWritten = '';

  /// Keeps $bootDir/ffbridge-backup.json up to date (checked every minute, written only on change).
  void keepCopyOn(String bootDir, void Function(String) warn) {
    if (bootDir.isEmpty) return;
    void tick() {
      if (!Directory(bootDir).existsSync()) return;
      final files = collect();
      final fingerprint = jsonEncode(files);
      if (fingerprint == _lastWritten) return;
      // Don't overwrite a good backup with an empty fresh setup.
      if (printerCount() == 0 && _lastWritten.isEmpty && File('$bootDir/$backupFileName').existsSync()) {
        _lastWritten = fingerprint;
        return;
      }
      try {
        final f = File('$bootDir/$backupFileName');
        final tmp = File('$bootDir/ffbridge-backup.tmp');
        tmp.writeAsStringSync(const JsonEncoder.withIndent(' ').convert(build()), flush: true);
        if (f.existsSync()) f.deleteSync();
        tmp.renameSync(f.path);
        _lastWritten = fingerprint;
      } catch (e) {
        warn('Could not update the backup on the SD card: $e');
      }
    }

    tick();
    _timer = Timer.periodic(const Duration(minutes: 1), (_) => tick());
  }

  void flushNow(String bootDir) {
    _timer?.cancel();
    if (bootDir.isNotEmpty) keepCopyOn(bootDir, (_) {});
    _timer?.cancel();
  }
}
