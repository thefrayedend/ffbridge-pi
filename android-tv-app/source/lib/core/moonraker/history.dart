// Print history (server.history.*) persisted as JSON.
import 'dart:convert';
import 'dart:io';

class JobHistory {
  final File file;
  List<Map<String, dynamic>> jobs = [];
  int _nextId = 1;

  JobHistory(String dataDir) : file = File('$dataDir/history.json') {
    try {
      jobs = [for (final j in jsonDecode(file.readAsStringSync()) as List) Map<String, dynamic>.from(j as Map)];
      for (final j in jobs) {
        final id = int.tryParse(j['job_id'].toString(), radix: 16) ?? 0;
        if (id >= _nextId) _nextId = id + 1;
      }
    } catch (_) {}
  }

  void save() {
    try {
      if (jobs.length > 500) jobs = jobs.sublist(jobs.length - 500);
      file.writeAsStringSync(jsonEncode(jobs));
    } catch (_) {}
  }

  Map<String, dynamic> start(String filename, Map<String, dynamic> metadata) {
    final job = <String, dynamic>{
      'job_id': _nextId.toRadixString(16).padLeft(6, '0').toUpperCase(),
      'exists': true,
      'end_time': null,
      'filament_used': 0.0,
      'filename': filename,
      'metadata': metadata,
      'print_duration': 0.0,
      'status': 'in_progress',
      'start_time': DateTime.now().millisecondsSinceEpoch / 1000.0,
      'total_duration': 0.0,
      'user': '_TRUSTED_USER_',
      'auxiliary_data': <dynamic>[],
    };
    _nextId++;
    jobs.add(job);
    save();
    return job;
  }

  Map<String, dynamic>? get current => jobs.isNotEmpty && jobs.last['status'] == 'in_progress' ? jobs.last : null;

  Map<String, dynamic>? finish(String status, {double? printDuration, double? filamentUsed}) {
    final j = current;
    if (j == null) return null;
    final now = DateTime.now().millisecondsSinceEpoch / 1000.0;
    j['status'] = status;
    j['end_time'] = now;
    j['total_duration'] = now - (j['start_time'] as num);
    if (printDuration != null) j['print_duration'] = printDuration;
    if (filamentUsed != null) j['filament_used'] = filamentUsed;
    save();
    return j;
  }

  Map<String, dynamic> list({int limit = 50, int start = 0, double since = 0, double before = 0, String order = 'desc'}) {
    var l = jobs.where((j) {
      final st = (j['start_time'] as num).toDouble();
      if (since > 0 && st < since) return false;
      if (before > 0 && st > before) return false;
      return true;
    }).toList();
    if (order == 'desc') l = l.reversed.toList();
    final count = l.length;
    l = l.skip(start).take(limit).toList();
    return {'count': count, 'jobs': l};
  }

  Map<String, dynamic> totals() {
    double tt = 0, tp = 0, tf = 0, lj = 0, lp = 0;
    for (final j in jobs) {
      final td = (j['total_duration'] as num).toDouble();
      final pd = (j['print_duration'] as num).toDouble();
      tt += td;
      tp += pd;
      tf += (j['filament_used'] as num).toDouble();
      if (td > lj) lj = td;
      if (pd > lp) lp = pd;
    }
    return {
      'job_totals': {
        'total_jobs': jobs.length,
        'total_time': tt,
        'total_print_time': tp,
        'total_filament_used': tf,
        'longest_job': lj,
        'longest_print': lp,
      },
      'auxiliary_totals': <dynamic>[],
    };
  }

  void resetTotals() {}

  List<String> delete({String? uid, bool all = false}) {
    if (all) {
      final ids = jobs.map((e) => e['job_id'] as String).toList();
      jobs.clear();
      save();
      return ids;
    }
    jobs.removeWhere((j) => j['job_id'] == uid);
    save();
    return uid == null ? [] : [uid];
  }

  Map<String, dynamic>? get(String uid) {
    for (final j in jobs) {
      if (j['job_id'] == uid) return j;
    }
    return null;
  }
}
