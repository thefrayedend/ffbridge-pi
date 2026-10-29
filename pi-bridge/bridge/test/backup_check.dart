// Settings backup checks:  dart run test/backup_check.dart
import 'dart:convert';
import 'dart:io';

import '../src/backup.dart';

var fails = 0;
void check(String name, bool ok, [Object? detail]) {
  stdout.writeln('${ok ? 'ok  ' : 'FAIL'} $name${ok ? '' : '  -> $detail'}');
  if (!ok) fails++;
}

void main() {
  final tmp = Directory.systemTemp.createTempSync('ffb');
  final old = Directory('${tmp.path}/old')..createSync();
  final boot = Directory('${tmp.path}/boot')..createSync();
  File('${old.path}/ffbridge.json').writeAsStringSync(jsonEncode({
    'printers': [
      {'id': 'p1', 'name': 'Creator 5', 'checkCode': '12345678'}
    ]
  }));
  File('${old.path}/pi.json').writeAsStringSync('{"password":"x"}');
  Directory('${old.path}/printers/p1/config/.theme').createSync(recursive: true);
  File('${old.path}/printers/p1/history.json').writeAsStringSync('[]');
  File('${old.path}/printers/p1/config/.theme/default.json').writeAsStringSync('{}');
  Directory('${old.path}/printers/p1/gcodes').createSync(recursive: true);
  File('${old.path}/printers/p1/gcodes/big.gcode').writeAsStringSync('G1');
  File('${old.path}/ffbridge.log').writeAsStringSync('log');

  final b = Backup(old.path, '1.0.1');
  final files = b.collect();
  check('backup has settings, history and Mainsail settings', files.keys.toSet().containsAll(
      ['ffbridge.json', 'pi.json', 'printers/p1/history.json', 'printers/p1/config/.theme/default.json']), files.keys);
  check('backup leaves out print files and logs', !files.keys.any((k) => k.endsWith('.gcode') || k.endsWith('.log')), files.keys);
  check('a good backup validates', Backup.validate(b.build()) == null);
  check('a random file is refused', Backup.validate({'format': 'x'}) != null);
  check('a path outside the data folder is refused',
      Backup.validate({...b.build(), 'files': {'ffbridge.json': '{}', '../x': 'y'}}) != null);

  // Board keeps a copy on the SD card.
  b.keepCopyOn(boot.path, (_) {});
  b.flushNow(boot.path);
  final onCard = File('${boot.path}/$backupFileName');
  check('copy written to the FFBRIDGE drive', onCard.existsSync());

  // Fresh card: empty data folder + that file -> restored on start.
  final fresh = Directory('${tmp.path}/fresh')..createSync();
  final msg = Backup(fresh.path, '1.0.2').restoreFromBootDrive(boot.path);
  check('fresh card restores from the SD card copy', msg != null && msg.startsWith('Settings restored'), msg);
  check('printer and pairing code are back',
      File('${fresh.path}/ffbridge.json').readAsStringSync().contains('12345678'));

  // Already set up -> never overwritten.
  File('${fresh.path}/ffbridge.json').writeAsStringSync(jsonEncode({
    'printers': [
      {'id': 'p9', 'name': 'New'}
    ]
  }));
  check('a board that is already set up is not overwritten', Backup(fresh.path, '1.0.2').restoreFromBootDrive(boot.path) == null);
  check('its settings are untouched', File('${fresh.path}/ffbridge.json').readAsStringSync().contains('p9'));

  // A fresh board with nothing set up must not replace the good copy on the card.
  final empty = Directory('${tmp.path}/empty')..createSync();
  File('${empty.path}/ffbridge.json').writeAsStringSync('{"printers":[]}');
  final before = onCard.readAsStringSync();
  Backup(empty.path, '1.0.2').flushNow(boot.path);
  check('an empty setup does not overwrite a good backup on the card', onCard.readAsStringSync() == before);

  tmp.deleteSync(recursive: true);
  stdout.writeln(fails == 0 ? 'all backup checks passed' : '$fails FAILED');
  exit(fails == 0 ? 0 : 1);
}
