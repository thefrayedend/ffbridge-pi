// MJPEG fan-out relay: one upstream connection to the printer camera, any number
// of browser/TV clients. Also provides snapshots from the latest frame.
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

class MjpegRelay {
  final String Function() urlProvider;
  final _clients = <StreamController<Uint8List>>{};
  Uint8List? latest;
  DateTime latestAt = DateTime.fromMillisecondsSinceEpoch(0);
  HttpClient? _http;
  StreamSubscription<List<int>>? _sub;
  bool _running = false;
  Timer? _idleTimer;
  int _snapshotWaiters = 0;
  final _frameEvents = StreamController<Uint8List>.broadcast();
  String lastError = '';
  int frames = 0;

  MjpegRelay(this.urlProvider);

  bool get active => _running;
  Stream<Uint8List> get frameStream => _frameEvents.stream;

  void _ensureRunning() {
    _idleTimer?.cancel();
    if (_running) return;
    final url = urlProvider();
    if (url.isEmpty) return;
    _running = true;
    _connect(url);
  }

  Future<void> _connect(String url) async {
    while (_running) {
      try {
        _http = HttpClient()..connectionTimeout = const Duration(seconds: 5);
        final req = await _http!.getUrl(Uri.parse(url));
        final res = await req.close();
        if (res.statusCode != 200) throw HttpException('camera HTTP ${res.statusCode}');
        final done = Completer<void>();
        var pending = Uint8List(0);
        _sub = res.listen((chunk) {
          final data = pending.isEmpty
              ? Uint8List.fromList(chunk)
              : (Uint8List(pending.length + chunk.length)
                ..setAll(0, pending)
                ..setAll(pending.length, chunk));
          var from = 0;
          while (true) {
            final soi = _find(data, 0xD8, from);
            if (soi < 0) {
              pending = data.isNotEmpty && data.last == 0xFF ? Uint8List.fromList([0xFF]) : Uint8List(0);
              break;
            }
            final eoi = _find(data, 0xD9, soi + 2);
            if (eoi < 0) {
              pending = Uint8List.fromList(Uint8List.sublistView(data, soi));
              if (pending.length > 8 * 1024 * 1024) pending = Uint8List(0);
              break;
            }
            _emit(Uint8List.fromList(Uint8List.sublistView(data, soi, eoi + 2)));
            from = eoi + 2;
          }
        }, onDone: () => done.complete(), onError: (e) {
          if (!done.isCompleted) done.complete();
        }, cancelOnError: true);
        await done.future;
        lastError = 'camera stream ended';
      } catch (e) {
        lastError = e.toString();
      }
      _http?.close(force: true);
      if (_running) await Future.delayed(const Duration(seconds: 1));
    }
  }

  static int _find(Uint8List d, int marker, int from) {
    for (var i = from; i < d.length - 1; i++) {
      if (d[i] == 0xFF && d[i + 1] == marker) return i;
    }
    return -1;
  }

  void _emit(Uint8List jpeg) {
    latest = jpeg;
    latestAt = DateTime.now();
    frames++;
    _frameEvents.add(jpeg);
    for (final c in _clients.toList()) {
      if (!c.isPaused) c.add(jpeg);
    }
  }

  void _maybeStop() {
    if (_clients.isNotEmpty || _snapshotWaiters > 0 || _keepAliveCount > 0) return;
    _idleTimer?.cancel();
    _idleTimer = Timer(const Duration(seconds: 15), () {
      if (_clients.isNotEmpty || _keepAliveCount > 0) return;
      _running = false;
      _sub?.cancel();
      _http?.close(force: true);
    });
  }

  int _keepAliveCount = 0;

  /// Keeps the upstream open (used by the TV dashboard) until the returned function is called.
  void Function() hold() {
    _keepAliveCount++;
    _ensureRunning();
    var released = false;
    return () {
      if (released) return;
      released = true;
      _keepAliveCount--;
      _maybeStop();
    };
  }

  /// Restart upstream (e.g. URL changed).
  void restart() {
    _running = false;
    _sub?.cancel();
    _http?.close(force: true);
    if (_clients.isNotEmpty || _keepAliveCount > 0) {
      Future.delayed(const Duration(milliseconds: 300), _ensureRunning);
    }
  }

  Future<Uint8List?> snapshot() async {
    if (latest != null && DateTime.now().difference(latestAt).inSeconds < 2) return latest;
    _snapshotWaiters++;
    _ensureRunning();
    try {
      return await _frameEvents.stream.first.timeout(const Duration(seconds: 10));
    } catch (_) {
      return latest;
    } finally {
      _snapshotWaiters--;
      _maybeStop();
    }
  }

  /// Serves a multipart MJPEG stream to [req].
  Future<void> serveStream(HttpRequest req, {int maxFps = 0}) async {
    final res = req.response;
    const boundary = 'ffbridgeframe';
    res.headers
      ..set('Content-Type', 'multipart/x-mixed-replace; boundary=$boundary')
      ..set('Cache-Control', 'no-cache, no-store, must-revalidate')
      ..set('Pragma', 'no-cache')
      ..set('Access-Control-Allow-Origin', '*');
    res.bufferOutput = false;
    final ctrl = StreamController<Uint8List>();
    _clients.add(ctrl);
    _ensureRunning();
    var lastSent = DateTime.fromMillisecondsSinceEpoch(0);
    try {
      if (latest != null) {
        res.add(_part(boundary, latest!));
      }
      await for (final f in ctrl.stream) {
        if (maxFps > 0 && DateTime.now().difference(lastSent).inMilliseconds < 1000 ~/ maxFps) continue;
        lastSent = DateTime.now();
        res.add(_part(boundary, f));
        await res.flush();
      }
    } catch (_) {
      // client went away
    } finally {
      _clients.remove(ctrl);
      await ctrl.close();
      try {
        await res.close();
      } catch (_) {}
      _maybeStop();
    }
  }

  List<int> _part(String boundary, Uint8List jpeg) {
    final head = '--$boundary\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n'.codeUnits;
    return [...head, ...jpeg, 13, 10];
  }

  void dispose() {
    _running = false;
    _sub?.cancel();
    _http?.close(force: true);
    for (final c in _clients) {
      c.close();
    }
  }
}
