import 'dart:async';
import 'dart:io';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/providers/feature_message.provider.dart';
import 'package:immich_mobile/providers/gallery_permission.provider.dart';
import 'package:immich_mobile/providers/view_intent/view_intent_handler.provider.dart';
import 'package:immich_mobile/providers/websocket.provider.dart';
import 'package:immich_mobile/repositories/permission.repository.dart';
import 'package:immich_mobile/routing/router.dart';

bool _isSyncRemoteDeletionsMode() => Platform.isAndroid && Store.get(StoreKey.manageLocalMediaAndroid, false);

Future<void> _handleSyncFlow(WidgetRef ref) async {
  final backgroundManager = ref.read(backgroundSyncProvider);
  final viewIntentHandler = ref.read(viewIntentHandlerProvider);

  await backgroundManager.syncLocal(full: true);
  await backgroundManager.syncRemote();
  await viewIntentHandler.flushDeferredViewIntent();
  await backgroundManager.hashAssets();

  if (SettingsRepository.instance.appConfig.backup.syncAlbums) {
    await backgroundManager.syncLinkedAlbum();
  }
}

Future<void> _requestManageMediaPermission(BuildContext context, WidgetRef ref) async {
  final hasPermission = await ref.read(permissionRepositoryProvider).hasManageMediaPermission();
  if (!context.mounted) {
    return;
  }

  if (!hasPermission) {
    await showDialog(
      context: context,
      builder: (BuildContext context) {
        return AlertDialog(
          shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(10))),
          elevation: 5,
          title: Text(
            context.t.manage_media_access_title,
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: context.primaryColor),
          ),
          content: SingleChildScrollView(
            child: ListBody(
              children: [
                Text(context.t.manage_media_access_subtitle, style: const TextStyle(fontSize: 14)),
                const SizedBox(height: 4),
                Text(context.t.manage_media_access_rationale, style: const TextStyle(fontSize: 12)),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: Text(
                context.t.cancel,
                style: TextStyle(fontWeight: FontWeight.w600, color: context.primaryColor),
              ),
            ),
            TextButton(
              onPressed: () {
                unawaited(ref.read(permissionRepositoryProvider).requestManageMediaPermission());
                Navigator.of(context).pop();
              },
              child: Text(
                context.t.manage_media_access_settings,
                style: TextStyle(fontWeight: FontWeight.w600, color: context.primaryColor),
              ),
            ),
          ],
        );
      },
    );
  }
}

/// Steps shared by every successful sign-in: permissions, initial sync and navigating to the timeline.
Future<void> completePostLogin(BuildContext context, WidgetRef ref, {required bool connectWebsocket}) async {
  await ref.read(galleryPermissionNotifier.notifier).requestGalleryPermission();
  if (_isSyncRemoteDeletionsMode()) {
    if (!context.mounted) {
      return;
    }
    await _requestManageMediaPermission(context, ref);
  }
  unawaited(_handleSyncFlow(ref));
  if (!context.mounted) {
    return;
  }

  if (connectWebsocket) {
    ref.read(websocketProvider.notifier).connect();
  }
  unawaited(ref.read(featureMessageServiceProvider).markSeen());
  if (!context.mounted) {
    return;
  }

  unawaited(context.router.replaceAll([const TabShellRoute()]));
}
