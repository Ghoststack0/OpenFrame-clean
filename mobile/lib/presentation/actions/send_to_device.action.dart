import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/presentation/widgets/device_transfer/send_to_device_sheet.widget.dart';
import 'package:immich_mobile/providers/routes.provider.dart';

final _stateProvider = Provider.family.autoDispose<List<String>?, ActionSource>((ref, source) {
  if (ref.watch(inLockedViewProvider)) {
    return null;
  }

  final assets = ref.watch(assetsActionProvider(source));
  final remoteIds = assets.remote().map((asset) => asset.id).toList(growable: false);
  return remoteIds.isEmpty ? null : remoteIds;
}, dependencies: [assetsActionProvider]);

class SendToDeviceAction extends AssetActionBuilder {
  const SendToDeviceAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    final remoteIds = ref.watch(_stateProvider(source));
    if (remoteIds == null) {
      return null;
    }

    return .new(
      icon: Icons.send_to_mobile_rounded,
      label: context.t.send_to_device,
      onAction: () async => unawaited(showSendToDeviceSheet(context, remoteIds)),
    );
  }
}
