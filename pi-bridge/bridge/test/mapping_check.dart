// Plain-Dart checks for the smart filament -> slot matching. Run: dart run test/mapping_check.dart
import '../../../android-tv-app/source/lib/core/ff/models.dart';
import '../../../android-tv-app/source/lib/core/mapping.dart';

void expect(bool ok, String what) {
  if (!ok) throw StateError('FAILED: $what');
  print('ok - $what');
}

final slots = [
  SlotInfo(1, true, 'PLA', '#FFFFFF'),
  SlotInfo(2, true, 'PLA', '#F82D29'),
  SlotInfo(3, true, 'PETG', '#4CAAF8'),
  SlotInfo(4, true, 'PLA', '#1B1B1B'),
];

MappingPlan plan(List<SlicerFilament> f, [List<SlotInfo>? s]) => planMapping('test.3mf', f, s ?? slots)!;
String show(MappingPlan p) => p.lines.map((l) => 'F${l.filament.index + 1}->S${l.slot.slotId}(${l.colorDiff.toStringAsFixed(1)},${l.verdict})').join(' ');

void main() {
  var p = plan([SlicerFilament(0, 'PLA', '#FF0000'), SlicerFilament(1, 'PLA', '#000000')]);
  print(show(p));
  expect(p.lines[0].slot.slotId == 2 && p.lines[1].slot.slotId == 4 && p.confident, 'red + black find the red and black spools, out of slot order');

  p = plan([SlicerFilament(0, 'PLA', '#000000'), SlicerFilament(1, 'PLA', '#FFFFFF'), SlicerFilament(2, 'PETG', '#3399FF'), SlicerFilament(3, 'PLA', '#E53935')]);
  print(show(p));
  expect(p.lines.map((l) => l.slot.slotId).join() == '4132' && p.confident, 'four filaments in a different order map to the right four slots');

  p = plan([SlicerFilament(0, 'PLA', '#00C853')]);
  print(show(p));
  expect(!p.confident, 'green that is not loaded -> ask the user');

  p = plan([SlicerFilament(0, 'PLA', '#4CAAF8')]);
  print(show(p));
  expect(!p.confident && p.lines[0].slot.material == 'PLA', 'blue PLA is never silently printed with the blue PETG');

  p = plan([SlicerFilament(0, 'PLA Silk', '#F82D29')]);
  expect(p.confident && p.lines[0].slot.slotId == 2, 'PLA Silk accepts a PLA spool of the same colour');

  p = plan([SlicerFilament(0, 'PLA', '#FF0000')], [SlotInfo(1, false, 'PLA', '#FF0000'), SlotInfo(2, true, 'PLA', '#FFFFFF')]);
  expect(p.lines[0].slot.slotId == 2 && !p.confident, 'empty slots are ignored');

  p = plan([SlicerFilament(0, 'PLA', '#FF0000'), SlicerFilament(1, 'PLA', '#000000')]);
  p.setSlot(0, 1);
  expect(p.lines[0].slot.slotId == 1 && !p.confident, 'manual override from the pop-up is kept');

  expect(colorName('#F82D29') == 'red' && colorName('#1B1B1B') == 'black' && colorName('#4CAAF8') .contains('blue'), 'colour names for the pop-up');
  expect(deltaE2000('#FFFFFF', '#FFFFFF') < 0.01 && deltaE2000('#000000', '#FFFFFF') > 90, 'colour difference sanity');
  print('all mapping checks passed');
}
