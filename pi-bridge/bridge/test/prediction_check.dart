// Plain-Dart checks for the failure-prediction maths (no package:test needed).
// Run: dart run test/prediction_check.dart
import '../src/ai_monitor.dart';

void expect(bool ok, String what) {
  if (!ok) throw StateError('FAILED: $what');
  print('ok - $what');
}

List<Detection> frame(double p) => p <= 0 ? [] : [Detection('failure', p, 0, 0, 1, 1)];

void main() {
  final a = FailurePrediction();
  for (var i = 0; i < 200; i++) {
    a.update(frame(0.05)); // an earlier, clean print builds the long-term baseline
  }
  a.resetForNewPrint();
  for (var i = 0; i < 29; i++) {
    a.update(frame(3));
  }
  expect(!a.isFailing(1), 'no alert during the first 30 frames, even with strong detections');
  a.update(frame(3));
  expect(a.isFailing(1), 'alerts after warm-up with strong detections');

  final b = FailurePrediction();
  for (var i = 0; i < 400; i++) {
    b.update(frame(i.isEven ? 0.1 : 0.0));
  }
  expect(!b.isFailing(1.2), 'low background noise never alerts');

  final c = FailurePrediction();
  for (var i = 0; i < 100; i++) {
    c.update(frame(0.05));
  }
  var warnAt = -1, pauseAt = -1;
  for (var i = 0; i < 60; i++) {
    c.update(frame(1.2));
    if (warnAt < 0 && c.isFailing(1)) warnAt = i;
    if (pauseAt < 0 && c.isFailing(1, escalatingFactor: FdParams.escalatingFactor)) pauseAt = i;
  }
  expect(warnAt >= 0 && (pauseAt < 0 || pauseAt > warnAt), 'warning comes before pausing (warn=$warnAt pause=$pauseAt)');

  final d = FailurePrediction();
  d.update(frame(1));
  d.resetForNewPrint();
  expect(d.currentFrameNum == 0 && d.ewmMean == 0 && d.lifetimeFrameNum == 1, 'new print resets short-term state only');
  print('all prediction checks passed');
}
