// Printer address follower checks:  dart run test/finder_check.dart
import 'dart:io';

import '../src/core.dart';
import '../src/printer_finder.dart';

var fails = 0;
void check(String name, bool ok, [Object? detail]) {
  stdout.writeln('${ok ? 'ok  ' : 'FAIL'} $name${ok ? '' : '  -> $detail'}');
  if (!ok) fails++;
}

PrinterConfig pc(String id, String ip, String serial, {bool enabled = true}) =>
    PrinterConfig(id: id, name: id, ip: ip, serial: serial, checkCode: '12345678', port: 7125)..enabled = enabled;

DiscoveredPrinter dp(String ip, String serial) => DiscoveredPrinter('x', ip, serial, 'Creator 5', 8899, 0, 0);

Future<void> main() async {
  final ps = [pc('a', '192.168.1.50', 'SNA'), pc('b', '192.168.1.51', 'snb'), pc('c', '192.168.1.52', 'SNC', enabled: false), pc('d', '192.168.1.53', '')];
  final found = [dp('10.43.0.61', 'SNA'), dp('10.43.0.62', 'SNB'), dp('10.43.0.63', 'SNC'), dp('10.43.0.64', '')];

  var m = movedPrinters(ps, {'a', 'b', 'c', 'd'}, found);
  check('offline printer found at a new address is moved', m['a'] == '10.43.0.61', m);
  check('serial match ignores upper/lower case', m['b'] == '10.43.0.62', m);
  check('disabled printers are left alone', !m.containsKey('c'), m);
  check('printers without a serial are left alone', !m.containsKey('d'), m);
  m = movedPrinters(ps, {'b'}, found);
  check('online printers are never moved', !m.containsKey('a') && m.containsKey('b'), m);
  m = movedPrinters(ps, {'a'}, [dp('192.168.1.50', 'SNA')]);
  check('same address: nothing to do', m.isEmpty, m);
  m = movedPrinters(ps, {'a'}, [dp('10.43.0.70', 'OTHER')]);
  check('a different printer at some address is not taken', m.isEmpty, m);

  // Real host: a saved printer at a dead address is updated and its config saved.
  final dir = Directory.systemTemp.createTempSync('ffbfind');
  final host = BridgeHost(dir.path, dir.path);
  host.config.printers.add(pc('p1', '10.99.99.99', 'SNC5TEST01'));
  host.config.save();
  var searches = 0;
  final f = PrinterFinder(host, discover: () async {
    searches++;
    return [dp('127.0.0.1', 'SNC5TEST01')];
  });
  await f.check(offlineFor: const Duration(hours: 1));
  check('waits before searching (printer only just went offline)', searches == 0 && host.config.printers.first.ip == '10.99.99.99');
  await f.check(offlineFor: Duration.zero);
  check('searches once the printer has been offline long enough', searches == 1);
  check('address updated', host.config.printers.first.ip == '127.0.0.1', host.config.printers.first.ip);
  final saved = File('${dir.path}/ffbridge.json').readAsStringSync();
  check('new address saved to the settings file', saved.contains('127.0.0.1') && !saved.contains('10.99.99.99'));
  await host.stopAll();
  dir.deleteSync(recursive: true);

  stdout.writeln(fails == 0 ? 'all finder checks passed' : '$fails FAILED');
  exit(fails == 0 ? 0 : 1);
}
