// Spoolman REST client (used for the Moonraker server.spoolman.* emulation).
import 'dart:convert';
import 'dart:io';

class SpoolmanClient {
  String baseUrl;
  final HttpClient _http = HttpClient()..connectionTimeout = const Duration(seconds: 6);
  SpoolmanClient(this.baseUrl);

  String get _base => baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
  bool get configured => baseUrl.trim().isNotEmpty;

  /// Returns (statusCode, decodedBody).
  Future<(int, dynamic)> request(String method, String path, {Map<String, dynamic>? query, Object? body}) async {
    var p = path.startsWith('/') ? path : '/$path';
    if (!p.startsWith('/api')) p = '/api$p';
    var uri = Uri.parse('$_base$p');
    if (query != null && query.isNotEmpty) {
      uri = uri.replace(queryParameters: {...uri.queryParameters, ...query.map((k, v) => MapEntry(k, v.toString()))});
    }
    final req = await _http.openUrl(method.toUpperCase(), uri).timeout(const Duration(seconds: 8));
    if (body != null) {
      req.headers.contentType = ContentType.json;
      final b = utf8.encode(body is String ? body : jsonEncode(body));
      req.contentLength = b.length;
      req.add(b);
    }
    final res = await req.close().timeout(const Duration(seconds: 10));
    final text = await res.transform(utf8.decoder).join();
    dynamic decoded;
    try {
      decoded = text.isEmpty ? null : jsonDecode(text);
    } catch (_) {
      decoded = text;
    }
    return (res.statusCode, decoded);
  }

  Future<bool> ping() async {
    try {
      final (code, _) = await request('GET', '/v1/health');
      return code == 200;
    } catch (_) {
      return false;
    }
  }

  Future<void> useFilament(int spoolId, {double? lengthMm, double? weightG}) async {
    final body = <String, dynamic>{};
    if (weightG != null && weightG > 0) {
      body['use_weight'] = weightG;
    } else if (lengthMm != null && lengthMm > 0) {
      body['use_length'] = lengthMm;
    } else {
      return;
    }
    await request('PUT', '/v1/spool/$spoolId/use', body: body);
  }
}
