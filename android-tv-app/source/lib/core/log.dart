// Tiny logger writing to a rotating file + in-memory ring for the TV UI.
import 'dart:collection';
import 'dart:io';

class Log {
  final File? file;
  final lines = ListQueue<String>();
  Log([String? path]) : file = path == null ? null : File(path) {
    try {
      if (file != null && file!.existsSync() && file!.lengthSync() > 2 * 1024 * 1024) {
        file!.renameSync('${file!.path}.1');
      }
    } catch (_) {}
  }

  void _w(String level, String msg) {
    final line = '${DateTime.now().toIso8601String()} [$level] $msg';
    lines.add(line);
    while (lines.length > 300) {
      lines.removeFirst();
    }
    // ignore: avoid_print
    print(line);
    try {
      file?.writeAsStringSync('$line\n', mode: FileMode.append);
    } catch (_) {}
  }

  void info(String m) => _w('INFO', m);
  void warn(String m) => _w('WARN', m);
  void error(String m) => _w('ERROR', m);
}
