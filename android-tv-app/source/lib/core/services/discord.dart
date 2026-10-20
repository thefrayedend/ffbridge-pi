// Discord webhook notifications (optionally with a camera snapshot).
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

class DiscordNotifier {
  String webhookUrl;
  DateTime _last = DateTime.fromMillisecondsSinceEpoch(0);
  DiscordNotifier(this.webhookUrl);

  bool get configured => webhookUrl.trim().startsWith('https://');

  Future<void> send({
    required String title,
    required String description,
    int color = 0x2196F3,
    Map<String, String> fields = const {},
    Uint8List? image,
    Uint8List? thumbnail,
  }) async {
    if (!configured) return;
    // simple rate limiting (Discord allows ~5 req / 2 s)
    final since = DateTime.now().difference(_last);
    if (since.inMilliseconds < 1500) await Future.delayed(Duration(milliseconds: 1500 - since.inMilliseconds));
    _last = DateTime.now();
    final embed = <String, dynamic>{
      'title': title,
      'description': description,
      'color': color,
      'timestamp': DateTime.now().toUtc().toIso8601String(),
      'footer': {'text': 'FlashForge TV Bridge'},
      'fields': [for (final e in fields.entries) {'name': e.key, 'value': e.value, 'inline': true}],
      if (image != null) 'image': {'url': 'attachment://snapshot.jpg'},
      if (thumbnail != null) 'thumbnail': {'url': 'attachment://thumb.png'},
    };
    final payload = jsonEncode({
      'username': 'FlashForge',
      'embeds': [embed]
    });
    final client = HttpClient();
    try {
      final req = await client.postUrl(Uri.parse(webhookUrl));
      if (image == null && thumbnail == null) {
        req.headers.contentType = ContentType.json;
        req.add(utf8.encode(payload));
      } else {
        final boundary = 'ffb${DateTime.now().microsecondsSinceEpoch}';
        req.headers.set('Content-Type', 'multipart/form-data; boundary=$boundary');
        final b = BytesBuilder();
        void part(String name, String? filename, String type, List<int> data) {
          b.add(utf8.encode('--$boundary\r\nContent-Disposition: form-data; name="$name"'
              '${filename != null ? '; filename="$filename"' : ''}\r\nContent-Type: $type\r\n\r\n'));
          b.add(data);
          b.add(utf8.encode('\r\n'));
        }

        part('payload_json', null, 'application/json', utf8.encode(payload));
        if (image != null) part('files[0]', 'snapshot.jpg', 'image/jpeg', image);
        if (thumbnail != null) part('files[1]', 'thumb.png', 'image/png', thumbnail);
        b.add(utf8.encode('--$boundary--\r\n'));
        final bytes = b.toBytes();
        req.contentLength = bytes.length;
        req.add(bytes);
      }
      final res = await req.close().timeout(const Duration(seconds: 20));
      await res.drain<void>();
    } catch (_) {
      // ignore network errors
    } finally {
      client.close();
    }
  }
}
