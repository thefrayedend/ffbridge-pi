// Minimal ZIP reader (stored + deflate) used for 3MF thumbnails and for
// unpacking the bundled Mainsail web UI. Pure dart:io.
import 'dart:io';
import 'dart:typed_data';

class ZipEntry {
  final String name;
  final int method, compressedSize, size, localHeaderOffset;
  ZipEntry(this.name, this.method, this.compressedSize, this.size, this.localHeaderOffset);
  bool get isDir => name.endsWith('/');
}

class ZipReader {
  final Uint8List data;
  late final List<ZipEntry> entries = _readCentral();
  ZipReader(this.data);

  static ZipReader? tryFile(String path) {
    try {
      return ZipReader(File(path).readAsBytesSync());
    } catch (_) {
      return null;
    }
  }

  List<ZipEntry> _readCentral() {
    final bd = ByteData.sublistView(data);
    var eocd = -1;
    for (var i = data.length - 22; i >= 0 && i >= data.length - 65557; i--) {
      if (bd.getUint32(i, Endian.little) == 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw const FormatException('Not a zip file');
    var count = bd.getUint16(eocd + 10, Endian.little);
    var cdOffset = bd.getUint32(eocd + 16, Endian.little);
    // ZIP64 support (large 3MF files)
    if (cdOffset == 0xFFFFFFFF || count == 0xFFFF) {
      final loc = eocd - 20;
      if (loc >= 0 && bd.getUint32(loc, Endian.little) == 0x07064b50) {
        final z64 = bd.getUint64(loc + 8, Endian.little);
        count = bd.getUint64(z64 + 32, Endian.little);
        cdOffset = bd.getUint64(z64 + 48, Endian.little);
      }
    }
    final out = <ZipEntry>[];
    var p = cdOffset;
    for (var n = 0; n < count && p + 46 <= data.length; n++) {
      if (bd.getUint32(p, Endian.little) != 0x02014b50) break;
      final method = bd.getUint16(p + 10, Endian.little);
      var csize = bd.getUint32(p + 20, Endian.little);
      var usize = bd.getUint32(p + 24, Endian.little);
      final nlen = bd.getUint16(p + 28, Endian.little);
      final xlen = bd.getUint16(p + 30, Endian.little);
      final clen = bd.getUint16(p + 32, Endian.little);
      var off = bd.getUint32(p + 42, Endian.little);
      final name = String.fromCharCodes(data.sublist(p + 46, p + 46 + nlen));
      // zip64 extra field
      var x = p + 46 + nlen;
      final xend = x + xlen;
      while (x + 4 <= xend) {
        final id = bd.getUint16(x, Endian.little);
        final sz = bd.getUint16(x + 2, Endian.little);
        if (id == 1) {
          var q = x + 4;
          if (usize == 0xFFFFFFFF) {
            usize = bd.getUint64(q, Endian.little);
            q += 8;
          }
          if (csize == 0xFFFFFFFF) {
            csize = bd.getUint64(q, Endian.little);
            q += 8;
          }
          if (off == 0xFFFFFFFF) off = bd.getUint64(q, Endian.little);
        }
        x += 4 + sz;
      }
      out.add(ZipEntry(name, method, csize, usize, off));
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }

  ZipEntry? find(bool Function(String name) test) {
    for (final e in entries) {
      if (test(e.name)) return e;
    }
    return null;
  }

  Uint8List read(ZipEntry e) {
    final bd = ByteData.sublistView(data);
    final p = e.localHeaderOffset;
    final nlen = bd.getUint16(p + 26, Endian.little);
    final xlen = bd.getUint16(p + 28, Endian.little);
    final start = p + 30 + nlen + xlen;
    final raw = data.sublist(start, start + e.compressedSize);
    if (e.method == 0) return raw;
    if (e.method == 8) return Uint8List.fromList(ZLibDecoder(raw: true).convert(raw));
    throw FormatException('Unsupported zip method ${e.method}');
  }

  /// Extracts all entries below [dir].
  void extractTo(String dir) {
    for (final e in entries) {
      final safe = e.name.replaceAll('\\', '/');
      if (safe.contains('..')) continue;
      final path = '$dir/$safe';
      if (e.isDir) {
        Directory(path).createSync(recursive: true);
      } else {
        File(path)
          ..parent.createSync(recursive: true)
          ..writeAsBytesSync(read(e));
      }
    }
  }
}
