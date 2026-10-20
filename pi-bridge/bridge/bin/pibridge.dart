// FlashForge Pi Bridge - headless entry point for single-board computers.
//
//   pibridge --data /var/lib/ffbridge --mainsail /opt/ffbridge/mainsail
//            --setup-web /opt/ffbridge/setup-web --setup-port 80
//            --ai-url http://127.0.0.1:3333 --boot-partition /ffsetup
//
// Starts one Moonraker/Mainsail server per configured printer (ports 7125, 7126, ...),
// the setup page, and the AI failure-detection monitor.
import 'dart:async';
import 'dart:io';

import '../src/ai_monitor.dart';
import '../src/boot_config.dart';
import '../src/core.dart';
import '../src/pi_config.dart';
import '../src/setup_server.dart';
import '../src/system_control.dart';

const mainsailAssetVersion = '2.19.0';

String _arg(List<String> args, String name, String def) {
  final i = args.indexOf(name);
  return (i >= 0 && i + 1 < args.length) ? args[i + 1] : def;
}

/// Extracts the bundled Mainsail zip if the web root is missing (dev runs). The image
/// build pre-extracts it, so on the board this is a no-op.
String _prepareMainsail(String dir, String zip) {
  final marker = File('$dir/.ffbridge_version');
  if (File('$dir/index.html').existsSync()) return dir;
  if (!File(zip).existsSync()) {
    stderr.writeln('Mainsail not found in $dir and no zip at $zip');
    return dir;
  }
  Directory(dir).createSync(recursive: true);
  ZipReader(File(zip).readAsBytesSync()).extractTo(dir);
  marker.writeAsStringSync(mainsailAssetVersion);
  return dir;
}

Future<void> main(List<String> args) async {
  if (args.contains('--help') || args.contains('-h')) {
    stdout.writeln('pibridge [--data DIR] [--mainsail DIR] [--mainsail-zip FILE] [--setup-web DIR] [--setup-port N] '
        '[--ai-url URL] [--boot-partition DIR] [--no-ai]');
    return;
  }
  final scriptDir = File(Platform.script.toFilePath()).parent.path;
  final data = _arg(args, '--data', './ffdata');
  final mainsail = _prepareMainsail(_arg(args, '--mainsail', './mainsail'),
      _arg(args, '--mainsail-zip', '$scriptDir/../../../android-tv-app/source/assets/mainsail.zip'));
  final setupWeb = _arg(args, '--setup-web', '$scriptDir/../web');
  final setupPort = int.parse(_arg(args, '--setup-port', '8088'));
  final aiUrl = Uri.parse(_arg(args, '--ai-url', 'http://127.0.0.1:3333'));
  final bootPartition = _arg(args, '--boot-partition', '');

  final host = BridgeHost(data, mainsail);
  host.log.info('FlashForge Pi Bridge $piBridgeVersion starting (data=$data, setup port $setupPort)');
  final pi = PiConfig(data);
  final sys = SystemControl();
  final ai = AiMonitor(host, pi, aiUrl, host.log);
  final setup = SetupServer(host: host, pi: pi, ai: ai, sys: sys, webDir: setupWeb, port: setupPort);

  await host.startAll();
  await setup.start();
  if (!args.contains('--no-ai')) ai.start();

  BootConfig? boot;
  if (bootPartition.isNotEmpty) {
    boot = BootConfig(bootPartition, host);
    unawaited(boot.applyPrinter().catchError((Object e) => host.log.warn('Boot config printer import failed: $e')));
    Future<void> writeAddr() async => boot!.writeAddressFile(SystemControl.hostname(), await SystemControl.localIps());
    unawaited(writeAddr());
    Timer.periodic(const Duration(seconds: 30), (_) => writeAddr());
  }

  Future<void> shutdown(ProcessSignal s) async {
    host.log.info('Stopping ($s)');
    ai.stop();
    await setup.stop();
    await host.stopAll();
    exit(0);
  }

  ProcessSignal.sigint.watch().listen(shutdown);
  if (!Platform.isWindows) ProcessSignal.sigterm.watch().listen(shutdown);
}
