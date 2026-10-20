// Minimal legacy TCP (port 8899) G-code channel used by 5M / 5M Pro / AD5X for
// commands that are not exposed by the HTTP API (homing, jogging, raw G-code).
// The Creator 5 series has no TCP server and never uses this.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

class FlashForgeTcpClient {
  final String ip;
  final int port;
  Socket? _sock;
  final _buf = StringBuffer();
  Completer<String>? _pending;
  Future<void> _queue = Future.value();
  Timer? _keepAlive;

  FlashForgeTcpClient(this.ip, {this.port = 8899});

  Future<void> connect() async {
    _sock = await Socket.connect(ip, port, timeout: const Duration(seconds: 4));
    _sock!.listen((d) {
      _buf.write(latin1.decode(d));
      final s = _buf.toString();
      if (_pending != null && s.trimRight().endsWith('ok')) {
        _buf.clear();
        _pending?.complete(s);
        _pending = null;
      }
    }, onDone: () {
      _sock = null;
      _pending?.completeError(const SocketException('closed'));
      _pending = null;
    }, onError: (_) {});
    final r = await _send('~M601 S1');
    if (r == null) throw const SocketException('login failed');
    _keepAlive = Timer.periodic(const Duration(seconds: 5), (_) => _send('~M27'));
  }

  Future<String?> _send(String cmd) {
    final c = Completer<String?>();
    _queue = _queue.then((_) async {
      if (_sock == null) {
        c.complete(null);
        return;
      }
      _pending = Completer<String>();
      _buf.clear();
      _sock!.write('$cmd\n');
      try {
        c.complete(await _pending!.future.timeout(const Duration(seconds: 8)));
      } catch (_) {
        _pending = null;
        c.complete(null);
      }
    });
    return c.future;
  }

  /// Sends a G-code line (the "~" prefix is added) and returns the printer reply.
  Future<String?> gcode(String line) => _send(line.startsWith('~') ? line : '~$line');

  Future<void> close() async {
    _keepAlive?.cancel();
    if (_sock != null) {
      await _send('~M602');
      _sock?.destroy();
      _sock = null;
    }
  }
}
