// Plain-English error code lookup:  dart run test/errors_check.dart
import 'dart:io';

import '../src/core.dart';

var failed = 0;
void check(String name, bool ok) {
  print('${ok ? 'ok  ' : 'FAIL'} - $name');
  if (!ok) failed++;
}

void main() {
  check('no error -> null', explainError('', '5m') == null && explainError('0', 'ad5x') == null);
  check('formats normalised', normalizeErrorCode('E0012') == 'E0012' && normalizeErrorCode('12') == 'E0012' && normalizeErrorCode('e0012') == 'E0012');
  check('5M: E0012 is X homing', explainError('E0012', '5m')!.title.contains('X-axis'));
  check('AD5X: shared code', explainError('E0100', 'ad5x')!.title.contains('Slot 1'));
  check('AD5X: own code E0113', explainError('E0113', 'ad5x')!.title.contains('stuck'));
  check('5M has no E0113 -> generic answer', explainError('E0113', '5m')!.title == 'Printer error E0113');
  check('Creator 5 numbering differs (E0005)', explainError('E0005', 'creator5')!.title != explainError('E0005', '5m')!.title);
  check('Creator 5: filament runout', explainError('E0162', 'creator5')!.title.contains('filament ran out'));
  check('wiki link per model', explainError('E0162', 'creator5')!.wikiUrl.contains('creator-5') && explainError('E0012', 'ad5x')!.wikiUrl.contains('ad5x'));
  print(failed == 0 ? 'all error checks passed' : '$failed FAILED');
  exit(failed == 0 ? 0 : 1);
}
