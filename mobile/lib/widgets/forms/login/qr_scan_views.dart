import 'dart:async';

import 'package:flutter/material.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_ui/immich_ui.dart';

/// A frame to aim the camera, the usage hint, and a message when a scanned code isn't ours.
class QrScanOverlay extends StatelessWidget {
  final bool showInvalid;

  const QrScanOverlay({super.key, required this.showInvalid});

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Stack(
      children: [
        Center(
          child: ExcludeSemantics(
            child: Container(
              width: 240,
              height: 240,
              decoration: BoxDecoration(
                border: Border.all(color: Colors.white, width: 3),
                borderRadius: const BorderRadius.all(Radius.circular(ImmichRadius.xxl)),
              ),
            ),
          ),
        ),
        Align(
          alignment: Alignment.bottomCenter,
          child: SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(ImmichSpacing.xl),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (showInvalid)
                    Semantics(
                      liveRegion: true,
                      child: Container(
                        margin: const EdgeInsets.only(bottom: ImmichSpacing.md),
                        padding: const EdgeInsets.all(ImmichSpacing.md),
                        decoration: BoxDecoration(
                          color: context.colorScheme.errorContainer,
                          borderRadius: const BorderRadius.all(Radius.circular(ImmichRadius.md)),
                        ),
                        child: Text(
                          t.qr_login_error_invalid_qr,
                          textAlign: TextAlign.center,
                          style: TextStyle(color: context.colorScheme.onErrorContainer, fontWeight: FontWeight.w600),
                        ),
                      ),
                    ),
                  Text(
                    t.qr_login_scan_hint,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Colors.white, fontSize: 14, height: 1.4),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Shown instead of the camera preview when the camera can't be used.
class QrScanErrorView extends StatelessWidget {
  final bool isPermissionDenied;
  final FutureOr<void> Function() onOpenSettings;
  final FutureOr<void> Function() onRetry;

  const QrScanErrorView({
    super.key,
    required this.isPermissionDenied,
    required this.onOpenSettings,
    required this.onRetry,
  });

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return ColoredBox(
      color: context.colorScheme.surface,
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(ImmichSpacing.xl),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 320),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Icon(
                  isPermissionDenied ? Icons.no_photography_outlined : Icons.videocam_off_outlined,
                  size: 56,
                  color: context.colorScheme.primary,
                ),
                const SizedBox(height: ImmichSpacing.lg),
                if (isPermissionDenied)
                  Semantics(
                    header: true,
                    child: Text(
                      t.qr_login_camera_denied_title,
                      textAlign: TextAlign.center,
                      style: context.textTheme.titleLarge,
                    ),
                  ),
                if (isPermissionDenied) const SizedBox(height: ImmichSpacing.sm),
                Text(
                  isPermissionDenied ? t.qr_login_camera_denied : t.qr_login_camera_error,
                  textAlign: TextAlign.center,
                  style: context.textTheme.bodyMedium,
                ),
                const SizedBox(height: ImmichSpacing.xl),
                if (isPermissionDenied)
                  ImmichTextButton(
                    labelText: t.qr_login_open_settings,
                    icon: Icons.settings_outlined,
                    onPressed: onOpenSettings,
                  ),
                if (isPermissionDenied) const SizedBox(height: ImmichSpacing.sm),
                ImmichTextButton(
                  labelText: t.retry,
                  icon: Icons.refresh_rounded,
                  variant: isPermissionDenied ? ImmichVariant.ghost : ImmichVariant.filled,
                  onPressed: onRetry,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
