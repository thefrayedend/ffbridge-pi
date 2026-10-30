// Slicer helper checks:  dart run test/slicer_check.dart
// (The engine itself is tested on the board's system by slicer/test-slicer-pack.sh in the GitHub build.)
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../../../android-tv-app/source/lib/core/moonraker/metadata.dart';
import '../src/core.dart';
import '../src/slicer.dart';

var fails = 0;
void check(String name, bool ok, [Object? detail]) {
  stdout.writeln('${ok ? 'ok  ' : 'FAIL'} $name${ok ? '' : '  -> $detail'}');
  if (!ok) fails++;
}

Future<void> main() async {
  // --- printer -> engine model
  const models = ['Flashforge AD5X', 'Flashforge Adventurer 5M', 'Flashforge Adventurer 5M Pro', 'Flashforge Creator 5', 'Flashforge Creator 5 Pro', 'Flashforge Guider4'];
  check('Creator 5 Pro', matchModel('Creator 5 Pro', models) == 'Flashforge Creator 5 Pro');
  check('Creator 5 is not taken for the Pro', matchModel('Creator 5', models) == 'Flashforge Creator 5');
  check('Adventurer 5M Pro', matchModel('Adventurer 5M Pro', models) == 'Flashforge Adventurer 5M Pro');
  check('AD5X', matchModel('AD5X', models) == 'Flashforge AD5X');
  check('Guider 4 (space)', matchModel('Guider 4', models) == 'Flashforge Guider4');
  check('unknown model -> none', matchModel('', models) == null && matchModel('Bambu Lab P2S', models) == null);

  check('0.4 nozzle by default', defaultNozzle(['X 0.25 nozzle', 'X 0.4 HF nozzle', 'X 0.4 nozzle', 'X 0.6 nozzle']) == 'X 0.4 nozzle');
  check('0.20mm Standard preferred', preferredProcess(['0.12mm Standard @FF C5', '0.20mm Standard @FF C5'], '0.12mm Standard @FF C5') == '0.20mm Standard @FF C5');

  // --- only the printer's own filaments
  final f = flashforgeFilaments(['Generic PLA @FF C5P', 'Bambu PLA Basic @BBL X1C', 'Generic ABS @System', 'Flashforge PLA Basic @FF C5P']);
  check('Flashforge filaments only', f.length == 2 && !f.any((x) => x.contains('Bambu') || x.contains('@System')), f);

  // --- what may be changed per print
  check('numbers / switches / choices allowed', overridable({'key': 'wall_loops', 'type': 'int'}) && overridable({'key': 'enable_support', 'type': 'bool'}));
  check('post-processing scripts refused', !overridable({'key': 'post_process', 'type': 'strings', 'vector': true}) && !overridable({'key': 'post_process', 'type': 'string'}));
  check('custom G-code refused', !overridable({'key': 'machine_start_gcode', 'type': 'string'}) && !overridable({'key': 'before_layer_change_gcode', 'type': 'float'}));
  check('file name format refused', !overridable({'key': 'filename_format', 'type': 'string'}));

  // --- bed
  final b = bedOf({'printable_area': ['0x0', '256x0', '256x256', '0x256'], 'printable_height': '256'});
  check('bed size', b['w'] == 256 && b['d'] == 256 && b['h'] == 256 && b['x0'] == 0, b);
  final b2 = bedOf({'printable_area': ['-110x-110', '110x-110', '110x110', '-110x110'], 'printable_height': '220'});
  check('centre-origin bed', b2['x0'] == -110 && b2['w'] == 220, b2);

  check('file names cleaned', safeName('My "part"/v2.3mf') == 'My _part__v2' && safeName('../..') == 'plate' && safeName('') == 'plate');

  // --- thumbnail + stats
  final dir = Directory.systemTemp.createTempSync('ffbslicer');
  final g = File('${dir.path}/a.gcode')
    ..writeAsStringSync('; HEADER_BLOCK_START\n; total layer number: 42\n; HEADER_BLOCK_END\n\nG1 X1 Y1 E1\n'
        '; filament used [mm] = 1000.00, 2500.00\n; filament used [g] = 3.00, 7.50\n; total filament used [g] = 10.50\n'
        '; total filament change = 12\n; estimated printing time (normal mode) = 1h 2m 3s\n');
  final png = _png();
  check('PNG data URL read', decodePngDataUrl('data:image/png;base64,${base64.encode(png)}')?.length == png.length);
  check('non-PNG refused', decodePngDataUrl('data:image/png;base64,${base64.encode([1, 2, 3])}') == null && decodePngDataUrl('data:text/html;base64,AAAA') == null);
  final out = File('${dir.path}/b.gcode');
  await addThumbnail(g, out, png);
  final t = out.readAsStringSync();
  check('thumbnail after the header', t.indexOf('; thumbnail begin 2x2') > t.indexOf('; HEADER_BLOCK_END') && t.contains('G1 X1 Y1 E1'));
  final md = await extractGcodeMetadata(out);
  check('bridge reads the thumbnail back', md.thumbs.isNotEmpty && md.thumbs.first.width == 2, md.thumbs.length);
  final st = gcodeStats(out);
  check('print time', st['time'] == '1h 2m 3s', st);
  check('grams per filament', (st['grams'] as List).length == 2 && (st['grams'] as List)[1] == 7.5, st);
  check('meters', (st['meters'] as List)[1] == 2.5, st);
  check('layers / changes', st['layers'] == 42 && st['changes'] == 12, st);

  // --- adding the plate picture to a sliced project
  final z = File('${dir.path}/p.gcode.3mf');
  final py = await Process.run('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED);z.writestr("Metadata/plate_1.gcode","G1\\n"*500);z.writestr("3D/3dmodel.model","<model/>");z.close()', z.path]);
  if (py.exitCode == 0) {
    zipAddStored(z, 'Metadata/plate_1.png', png);
    final zr = ZipReader.tryFile(z.path);
    check('zip still readable, picture added', zr != null && zr.find((n) => n == 'Metadata/plate_1.png') != null && zr.read(zr.find((n) => n == 'Metadata/plate_1.gcode')!).length == 1500);
    final t2 = await Process.run('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;assert z.read("Metadata/plate_1.png")[:4]==b"\\x89PNG"', z.path]);
    check('zip passes a full check (CRC)', t2.exitCode == 0, t2.stderr);
    final md3 = await extract3mfMetadata(z);
    check('bridge finds the plate picture', md3.thumbs.isNotEmpty);
  } else {
    stdout.writeln('skip zip checks (no python3)');
  }
  check('crc32', crc32(utf8.encode('123456789')) == 0xCBF43926);

  // --- engine events
  final j = SliceJob(name: 'x.gcode', printerId: 'p', dir: dir.path);
  j.onLine('[[SLICER_EVENT]] {"event":"progress","percent":42,"message":"Generating walls"}');
  j.onLine('[[SLICER_EVENT]] {"event":"slice_warning","message":"bed_temperature_too_high_than_filament","tag":"bed_temperature_too_high_than_filament"}');
  j.onLine('noise');
  check('progress read', j.percent == 42 && j.message == 'Generating walls');
  check('warning made readable', j.warnings.single.startsWith('The bed is hotter'));
  j.onLine('[[SLICER_EVENT]] {"event":"slice_error","message":"Nothing to print"}');
  check('error kept', j.error == 'Nothing to print');

  check('probe model is a valid STL', probeStl().length == 84 + 12 * 50);

  dir.deleteSync(recursive: true);
  stdout.writeln(fails == 0 ? 'all slicer checks passed' : '$fails FAILED');
  exit(fails == 0 ? 0 : 1);
}

Uint8List _png() => base64.decode('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNgYGD4z8DAwMDAwMDAAAANAAH/kHTgSQAAAABJRU5ErkJggg==');
