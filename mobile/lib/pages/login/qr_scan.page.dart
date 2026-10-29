import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/models/auth/login_response.model.dart';
import 'package:immich_mobile/models/auth/pairing_payload.model.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/utils/provider_utils.dart';
import 'package:immich_mobile/widgets/forms/login/pairing_confirm_sheet.dart';
import 'package:immich_mobile/widgets/forms/login/post_login.dart';
import 'package:immich_mobile/widgets/forms/login/qr_scan_views.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:permission_handler/permission_handler.dart';

@RoutePage()
class QrScanPage extends HookConsumerWidget {
  const QrScanPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Frames are never kept (`returnImage` is false) and only QR codes are decoded.
    final controller = useMemoized(
      () => MobileScannerController(formats: const [BarcodeFormat.qrCode], detectionSpeed: DetectionSpeed.noDuplicates),
    );
    final isHandling = useRef(false);
    final invalidScan = useState(false);

    useEffect(
      () =>
          () => unawaited(controller.dispose()),
      [controller],
    );

    useEffect(() {
      if (!invalidScan.value) {
        return null;
      }
      final timer = Timer(const Duration(seconds: 4), () => invalidScan.value = false);
      return timer.cancel;
    }, [invalidScan.value]);

    Future<bool> hasPassword() async {
      try {
        final status = await ref.read(apiServiceProvider).authenticationApi.getAuthStatus();
        return status?.password ?? false;
      } catch (_) {
        return false;
      }
    }

    Future<void> finishSignIn(LoginResponse response) async {
      // A passwordless OAuth account can retain the default `shouldChangePassword` flag.
      if (response.shouldChangePassword && !response.isAdmin && await hasPassword()) {
        if (context.mounted) {
          unawaited(context.pushRoute(const ChangePasswordRoute()));
        }
        return;
      }
      if (context.mounted) {
        await completePostLogin(context, ref, connectWebsocket: true);
      }
    }

    Future<void> onDetect(BarcodeCapture capture) async {
      if (isHandling.value) {
        return;
      }

      PairingPayload? payload;
      var sawInvalid = false;
      for (final barcode in capture.barcodes) {
        final text = barcode.rawValue;
        if (text == null) {
          continue;
        }
        try {
          payload = PairingPayload.parse(text);
          break;
        } on FormatException {
          sawInvalid = true;
        }
      }

      if (payload == null) {
        if (sawInvalid) {
          invalidScan.value = true;
        }
        return;
      }

      isHandling.value = true;
      invalidScan.value = false;
      final scanned = payload;
      LoginResponse? response;
      await controller.stop();
      if (!context.mounted) {
        return;
      }

      final connected = await PairingConfirmSheet.show(
        context,
        serverUrls: scanned.serverUrls,
        onConnect: (serverUrl) async {
          // Invalidate API repositories so they pick up the new endpoint and access token.
          invalidateAllApiRepositoryProviders(ref);
          response = await ref.read(authProvider.notifier).pairPhone(scanned, serverUrl: serverUrl);
        },
      );
      if (!context.mounted) {
        return;
      }

      final signedIn = response;
      if (connected && signedIn != null) {
        await finishSignIn(signedIn);
        return;
      }

      isHandling.value = false;
      await controller.start();
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(context.t.qr_login_scan, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16.0)),
      ),
      backgroundColor: Colors.black,
      body: MobileScanner(
        controller: controller,
        onDetect: onDetect,
        errorBuilder: (context, error) => QrScanErrorView(
          isPermissionDenied: error.errorCode == MobileScannerErrorCode.permissionDenied,
          onOpenSettings: openAppSettings,
          onRetry: controller.start,
        ),
        overlayBuilder: (context, constraints) => QrScanOverlay(showInvalid: invalidScan.value),
      ),
    );
  }
}
