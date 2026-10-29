import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/device_transfer.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/utils/device_transfer.utils.dart';
import 'package:logging/logging.dart';
import 'package:openapi/api.dart';

Future<void> showSendToDeviceSheet(BuildContext context, List<String> assetIds) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useSafeArea: true,
    builder: (_) => SendToDeviceSheet(assetIds: assetIds),
  );
}

class SendToDeviceSheet extends ConsumerStatefulWidget {
  const SendToDeviceSheet({super.key, required this.assetIds});

  final List<String> assetIds;

  @override
  ConsumerState<SendToDeviceSheet> createState() => _SendToDeviceSheetState();
}

class _SendToDeviceSheetState extends ConsumerState<SendToDeviceSheet> {
  static final _log = Logger('SendToDeviceSheet');

  DeviceTransferAction _action = DeviceTransferAction.open;
  String? _sendingTo;

  bool get _tooMany => widget.assetIds.length > deviceTransferMaxAssets;

  Future<void> _send(SessionTargetResponseDto target) async {
    if (_tooMany || _sendingTo != null) {
      return;
    }

    final toast = ref.read(toastServiceProvider);
    final t = context.t;
    final navigator = Navigator.of(context);
    setState(() => _sendingTo = target.id);
    try {
      await ref
          .read(deviceTransferServiceProvider)
          .send(targetSessionId: target.id, assetIds: widget.assetIds, action: _action);
      toast.success(t.device_transfer_sent(device: target.label));
      if (mounted) {
        navigator.pop();
      }
    } catch (error, stack) {
      _log.warning('Failed to send assets to device', error, stack);
      final failure = deviceTransferFailure(error);
      toast.error(switch (failure) {
        DeviceTransferFailure.unavailable => t.device_transfer_error_unavailable(device: target.label),
        DeviceTransferFailure.offline => t.device_transfer_error_offline(device: target.label),
        DeviceTransferFailure.invalid => t.device_transfer_error_invalid,
        DeviceTransferFailure.unknown => t.device_transfer_error_unknown,
      });
      if (failure == DeviceTransferFailure.unavailable || failure == DeviceTransferFailure.offline) {
        // the device went away, so refresh the list instead of leaving a dead entry
        ref.invalidate(deviceTransferTargetsProvider);
      }
    } finally {
      if (mounted) {
        setState(() => _sendingTo = null);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final targets = ref.watch(deviceTransferTargetsProvider);

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(header: true, child: Text(context.t.send_to_device, style: context.textTheme.titleLarge)),
          const SizedBox(height: 4),
          Text(context.t.device_transfer_pick_device(count: widget.assetIds.length)),
          if (_tooMany) ...[
            const SizedBox(height: 8),
            Semantics(
              liveRegion: true,
              child: Text(
                context.t.device_transfer_too_many(max: deviceTransferMaxAssets),
                style: TextStyle(color: context.colorScheme.error),
              ),
            ),
          ],
          const SizedBox(height: 16),
          Semantics(
            container: true,
            label: context.t.device_transfer_action_label,
            child: SegmentedButton<DeviceTransferAction>(
              showSelectedIcon: false,
              segments: [
                ButtonSegment(
                  value: DeviceTransferAction.open,
                  icon: const Icon(Icons.open_in_new_rounded),
                  label: Text(context.t.device_transfer_action_open),
                ),
                ButtonSegment(
                  value: DeviceTransferAction.download,
                  icon: const Icon(Icons.download_rounded),
                  label: Text(context.t.device_transfer_action_download),
                ),
              ],
              selected: {_action},
              onSelectionChanged: _sendingTo == null ? (selection) => setState(() => _action = selection.first) : null,
            ),
          ),
          const SizedBox(height: 8),
          targets.when(
            loading: () => Padding(
              padding: const EdgeInsets.symmetric(vertical: 24),
              child: Center(
                child: Semantics(label: context.t.loading, child: const CircularProgressIndicator()),
              ),
            ),
            error: (error, _) => Padding(
              padding: const EdgeInsets.symmetric(vertical: 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Semantics(liveRegion: true, child: Text(context.t.device_transfer_load_error)),
                  const SizedBox(height: 8),
                  OutlinedButton(
                    onPressed: () => ref.invalidate(deviceTransferTargetsProvider),
                    child: Text(context.t.retry),
                  ),
                ],
              ),
            ),
            data: (items) => items.isEmpty
                ? Padding(
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    child: Semantics(liveRegion: true, child: Text(context.t.device_transfer_empty)),
                  )
                : Column(
                    children: [
                      for (final target in items)
                        ListTile(
                          key: ValueKey(target.id),
                          contentPadding: EdgeInsets.zero,
                          enabled: !_tooMany && _sendingTo == null,
                          leading: Icon(deviceTransferIcon(deviceType: target.deviceType, deviceOS: target.deviceOS)),
                          title: Text(target.label),
                          trailing: _sendingTo == target.id
                              ? const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2))
                              : null,
                          onTap: () => _send(target),
                        ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}
