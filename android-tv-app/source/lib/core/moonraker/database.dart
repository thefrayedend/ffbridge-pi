// Moonraker "database" (namespaced key/value store) persisted as JSON.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'file_manager.dart' show RpcError;

class MoonDatabase {
  final File file;
  Map<String, dynamic> data = {};
  Timer? _saveTimer;

  MoonDatabase(String dataDir) : file = File('$dataDir/database.json') {
    try {
      data = Map<String, dynamic>.from(jsonDecode(file.readAsStringSync()));
    } catch (_) {}
    data.putIfAbsent('moonraker', () => <String, dynamic>{});
  }

  void _scheduleSave() {
    _saveTimer?.cancel();
    _saveTimer = Timer(const Duration(milliseconds: 500), flush);
  }

  void flush() {
    try {
      final tmp = File('${file.path}.tmp');
      tmp.writeAsStringSync(jsonEncode(data));
      tmp.renameSync(file.path);
    } catch (_) {}
  }

  List<String> get namespaces => data.keys.toList();

  List<String> _keyParts(Object? key) {
    if (key == null) return [];
    if (key is List) return key.map((e) => e.toString()).toList();
    final s = key.toString();
    return s.isEmpty ? [] : s.split('.');
  }

  dynamic getItem(String ns, Object? key) {
    if (!data.containsKey(ns)) throw RpcError(404, "Namespace '$ns' not found");
    dynamic cur = data[ns];
    for (final k in _keyParts(key)) {
      if (cur is Map && cur.containsKey(k)) {
        cur = cur[k];
      } else {
        throw RpcError(404, "Key '$key' in namespace '$ns' not found");
      }
    }
    return cur;
  }

  dynamic postItem(String ns, Object? key, dynamic value) {
    final parts = _keyParts(key);
    if (parts.isEmpty) {
      data[ns] = value;
    } else {
      var cur = (data[ns] is Map) ? data[ns] as Map : (data[ns] = <String, dynamic>{});
      for (var i = 0; i < parts.length - 1; i++) {
        final n = cur[parts[i]];
        if (n is Map) {
          cur = n;
        } else {
          final m = <String, dynamic>{};
          cur[parts[i]] = m;
          cur = m;
        }
      }
      cur[parts.last] = value;
    }
    _scheduleSave();
    return value;
  }

  dynamic deleteItem(String ns, Object? key) {
    final parts = _keyParts(key);
    final value = getItem(ns, key);
    if (parts.isEmpty) {
      data.remove(ns);
    } else {
      dynamic cur = data[ns];
      for (var i = 0; i < parts.length - 1; i++) {
        cur = cur[parts[i]];
      }
      (cur as Map).remove(parts.last);
      if (data[ns] is Map && (data[ns] as Map).isEmpty && ns != 'moonraker') data.remove(ns);
    }
    _scheduleSave();
    return value;
  }
}
