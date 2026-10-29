import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/services/timeline.service.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/download.action.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/asset_viewer.page.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/device_transfer.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:logging/logging.dart';
import 'package:openapi/api.dart';

/// Shows incoming device transfers above the whole app while the user is signed in.
///
/// Keeps [deviceTransferIncomingProvider] watched for the authenticated session, so transfers are received
/// no matter which screen is open.
class DeviceTransferOverlay extends ConsumerWidget {
  const DeviceTransferOverlay({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isAuthenticated = ref.watch(authProvider.select((state) => state.isAuthenticated));

    // The child stays at the same position in the tree so the navigator keeps its state on sign in and out.
    return Stack(
      fit: StackFit.expand,
      children: [
        child,
        if (isAuthenticated) const Positioned(top: 0, left: 0, right: 0, child: DeviceTransferBanners()),
      ],
    );
  }
}

class DeviceTransferBanners extends ConsumerStatefulWidget {
  const DeviceTransferBanners({super.key});

  @override
  ConsumerState<DeviceTransferBanners> createState() => _DeviceTransferBannersState();
}

class _DeviceTransferBannersState extends ConsumerState<DeviceTransferBanners> {
  static final _log = Logger('DeviceTransferBanners');

  final List<DeviceTransferResponseDto> _pending = [];
  final Map<String, String> _labels = {};
  final Set<String> _requestedSources = {};

  void _receive(DeviceTransferResponseDto transfer) {
    if (_pending.any((item) => item.id == transfer.id)) {
      return;
    }
    setState(() => _pending.add(transfer));
    unawaited(_resolveLabel(transfer.sourceSessionId));
  }

  // The event only carries the source session ID, so resolve its label from the online targets.
  Future<void> _resolveLabel(String sessionId) async {
    if (_labels.containsKey(sessionId) || !_requestedSources.add(sessionId)) {
      return;
    }
    try {
      final targets = await ref.read(deviceTransferServiceProvider).listTargets();
      if (!mounted) {
        return;
      }
      setState(() {
        for (final target in targets) {
          _labels[target.id] = target.label;
        }
      });
    } catch (error, stack) {
      _log.warning('Failed to resolve device transfer source', error, stack);
    }
  }

  void _dismiss(String id) {
    if (mounted) {
      setState(() => _pending.removeWhere((item) => item.id == id));
    }
  }

  void _dismissAll() => setState(_pending.clear);

  Future<List<RemoteAsset>> _resolveAssets(DeviceTransferResponseDto transfer) async {
    final assetService = ref.read(assetServiceProvider);
    final assets = <RemoteAsset>[];
    for (final id in transfer.assetIds) {
      final asset = await assetService.getRemoteAsset(id);
      if (asset != null) {
        assets.add(asset);
      }
    }
    return assets;
  }

  Future<void> _open(DeviceTransferResponseDto transfer) async {
    _dismiss(transfer.id);
    final assets = await _resolveAssets(transfer);
    if (!mounted) {
      return;
    }
    if (assets.isEmpty) {
      ref.read(toastServiceProvider).error(StaticTranslations.instance.device_transfer_items_unavailable);
      return;
    }

    AssetViewer.setAsset(ref, assets.first);
    await ref
        .read(appRouterProvider)
        .push(
          AssetViewerRoute(
            initialIndex: 0,
            timelineService: ref.read(timelineFactoryProvider).fromAssets(assets, TimelineOrigin.deepLink),
          ),
        );
  }

  Future<void> _download(DeviceTransferResponseDto transfer) async {
    _dismiss(transfer.id);
    final assets = await _resolveAssets(transfer);
    if (!mounted) {
      return;
    }
    if (assets.isEmpty) {
      ref.read(toastServiceProvider).error(StaticTranslations.instance.device_transfer_items_unavailable);
      return;
    }

    await downloadRemoteAssets(ref, assets);
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(deviceTransferIncomingProvider, (_, next) => next.whenData(_receive));

    if (_pending.isEmpty) {
      return const SizedBox.shrink();
    }

    return SafeArea(
      bottom: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final transfer in _pending)
              Padding(
                key: ValueKey(transfer.id),
                padding: const EdgeInsets.only(bottom: 8),
                child: DeviceTransferBanner(
                  message: context.t.device_transfer_received(
                    device: _labels[transfer.sourceSessionId] ?? context.t.device_transfer_unknown_device,
                    count: transfer.assetIds.length,
                  ),
                  action: transfer.action,
                  onAction: () =>
                      unawaited(transfer.action == DeviceTransferAction.open ? _open(transfer) : _download(transfer)),
                  onDismiss: () => _dismiss(transfer.id),
                ),
              ),
            if (_pending.length > 1)
              Align(
                alignment: AlignmentDirectional.centerEnd,
                child: TextButton(onPressed: _dismissAll, child: Text(context.t.device_transfer_dismiss_all)),
              ),
          ],
        ),
      ),
    );
  }
}

class DeviceTransferBanner extends StatelessWidget {
  const DeviceTransferBanner({
    super.key,
    required this.message,
    required this.action,
    required this.onAction,
    required this.onDismiss,
  });

  final String message;
  final DeviceTransferAction action;
  final VoidCallback onAction;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final isOpen = action == DeviceTransferAction.open;

    return Semantics(
      container: true,
      liveRegion: true,
      child: Material(
        elevation: 6,
        color: context.colorScheme.surfaceContainerHigh,
        borderRadius: const BorderRadius.all(Radius.circular(16)),
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(16, 8, 4, 8),
          child: Row(
            children: [
              Icon(isOpen ? Icons.open_in_new_rounded : Icons.download_rounded, color: context.colorScheme.primary),
              const SizedBox(width: 12),
              Expanded(child: Text(message, style: context.textTheme.bodyMedium)),
              const SizedBox(width: 8),
              FilledButton(onPressed: onAction, child: Text(isOpen ? context.t.open : context.t.download)),
              IconButton(
                tooltip: context.t.device_transfer_dismiss,
                icon: const Icon(Icons.close_rounded),
                onPressed: onDismiss,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
