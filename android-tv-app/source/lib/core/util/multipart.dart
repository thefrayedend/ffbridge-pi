// Streaming multipart/form-data parser that writes file parts straight to disk.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

class MultipartResult {
  final Map<String, String> fields = {};
  String? fileName;
  String? fileField;
  File? file;
  int fileSize = 0;
}

/// Parses [body] (the request stream) using [boundary]. Any part with a filename is
/// written to [tmpFile]; other parts are collected as text fields.
Future<MultipartResult> parseMultipart(Stream<List<int>> body, String boundary, File tmpFile) async {
  final res = MultipartResult();
  final delim = Uint8List.fromList(utf8.encode('\r\n--$boundary'));
  // The first boundary has no leading CRLF; prepend one so every boundary matches [delim].
  var buf = Uint8List.fromList([13, 10]);
  IOSink? sink;
  var inHeaders = true;
  var started = false;
  String? curName;
  BytesBuilder? fieldBuf;
  var done = false;

  int indexOf(Uint8List hay, Uint8List needle, [int from = 0]) {
    final last = hay.length - needle.length;
    outer:
    for (var i = from; i <= last; i++) {
      for (var j = 0; j < needle.length; j++) {
        if (hay[i + j] != needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  void emitData(Uint8List d) {
    if (d.isEmpty) return;
    if (sink != null) {
      sink!.add(d);
      res.fileSize += d.length;
    } else {
      fieldBuf?.add(d);
    }
  }

  Future<void> finishPart() async {
    if (sink != null) {
      await sink!.flush();
      await sink!.close();
      sink = null;
    } else if (curName != null && fieldBuf != null) {
      res.fields[curName!] = utf8.decode(fieldBuf!.toBytes(), allowMalformed: true);
    }
    curName = null;
    fieldBuf = null;
  }

  final headerEnd = Uint8List.fromList([13, 10, 13, 10]);
  await for (final chunk in body) {
    if (done) continue;
    final nb = Uint8List(buf.length + chunk.length)
      ..setRange(0, buf.length, buf)
      ..setRange(buf.length, buf.length + chunk.length, chunk);
    buf = nb;
    while (true) {
      if (!started) {
        final i = indexOf(buf, delim);
        if (i < 0) break;
        buf = buf.sublist(i + delim.length);
        started = true;
        inHeaders = true;
        continue;
      }
      if (inHeaders) {
        if (buf.length >= 2 && buf[0] == 45 && buf[1] == 45) {
          done = true; // closing boundary "--"
          break;
        }
        final h = indexOf(buf, headerEnd);
        if (h < 0) break;
        final headers = utf8.decode(buf.sublist(0, h), allowMalformed: true);
        buf = buf.sublist(h + 4);
        final cd = RegExp(r'content-disposition:[^\r\n]*', caseSensitive: false).stringMatch(headers) ?? '';
        curName = RegExp(r'name="([^"]*)"').firstMatch(cd)?.group(1);
        final fn = RegExp(r'filename="([^"]*)"').firstMatch(cd)?.group(1);
        if (fn != null && res.file == null) {
          res.fileName = fn;
          res.fileField = curName;
          res.file = tmpFile;
          sink = tmpFile.openWrite();
        } else {
          fieldBuf = BytesBuilder();
        }
        inHeaders = false;
        continue;
      }
      final i = indexOf(buf, delim);
      if (i < 0) {
        // keep a tail that might contain a partial delimiter
        final keep = delim.length + 4;
        if (buf.length > keep) {
          emitData(buf.sublist(0, buf.length - keep));
          buf = buf.sublist(buf.length - keep);
        }
        break;
      }
      emitData(buf.sublist(0, i));
      await finishPart();
      buf = buf.sublist(i + delim.length);
      // after the delimiter comes either "--" (end) or CRLF (next part)
      if (buf.length < 2) {
        inHeaders = true;
        break;
      }
      if (buf[0] == 45 && buf[1] == 45) {
        done = true;
        break;
      }
      if (buf[0] == 13 && buf[1] == 10) buf = buf.sublist(2);
      inHeaders = true;
    }
    if (sink != null) await sink!.flush();
  }
  if (sink != null) await finishPart();
  return res;
}
