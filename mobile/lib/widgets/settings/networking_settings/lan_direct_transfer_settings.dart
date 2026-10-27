import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/providers/lan_direct_transfer.provider.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';
import 'package:immich_ui/immich_ui.dart';

class LanDirectTransferSettings extends HookConsumerWidget {
  const LanDirectTransferSettings({super.key, required this.manualSwitchingEnabled});

  /// When true, the manual Automatic URL switching setting takes precedence and automatic transfer is not used.
  final bool manualSwitchingEnabled;

  static String? _probeResultText(BuildContext context, LanProbeResult result) => switch (result) {
    LanProbeResult.idle => context.t.local_network_status_checking,
    LanProbeResult.verified => context.t.local_network_status_verified,
    LanProbeResult.noCandidates => context.t.local_network_status_no_candidates,
    LanProbeResult.unreachable => context.t.local_network_status_unreachable,
    LanProbeResult.identityMismatch => context.t.local_network_status_identity_mismatch,
    LanProbeResult.insecureHttpRefused => context.t.local_network_status_insecure_refused,
    LanProbeResult.discoveryFailed => context.t.local_network_status_discovery_failed,
    LanProbeResult.disabled => context.t.local_network_status_disabled,
    LanProbeResult.manualOverride => null,
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final network = ref.watch(appConfigProvider).network;
    final automaticTransfer = useState(network.automaticLanTransfer);
    final allowInsecure = useState(network.allowInsecureLanTransfer);
    final lanRoute = ref.watch(lanDirectTransferProvider);

    final automaticTransferEnabled = !manualSwitchingEnabled;
    final insecureEnabled = automaticTransferEnabled && automaticTransfer.value;

    Future<void> saveAutomaticTransfer(bool value) async {
      await ref.read(settingsProvider).write(.networkAutomaticLanTransfer, value);
      unawaited(ref.read(authProvider.notifier).setOpenApiServiceEndpoint());
    }

    Future<void> handleAllowInsecureChanged(bool value) async {
      if (value) {
        final confirmed = await showDialog<bool>(
          context: context,
          builder: (_) => ConfirmDialog(
            title: context.t.allow_unencrypted_local_connections_title,
            content: context.t.allow_unencrypted_local_connections_content,
            ok: context.t.enable,
          ),
        );
        if (confirmed != true) {
          return;
        }
      }

      allowInsecure.value = value;
      await ref.read(settingsProvider).write(.networkAllowInsecureLanTransfer, value);
      unawaited(ref.read(authProvider.notifier).setOpenApiServiceEndpoint());
    }

    final isLan = lanRoute.route == LanRoute.lan;
    final routeUrl = lanRoute.url?.replaceFirst(RegExp(r'/api$'), '');
    final probeText = _probeResultText(context, lanRoute.lastProbeResult);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SettingGroupTitle(title: context.t.automatic_local_network_transfer, icon: Icons.swap_horiz_rounded),
        if (manualSwitchingEnabled)
          Padding(
            padding: const EdgeInsets.only(left: 20, right: 20, bottom: 8),
            child: Text(
              context.t.local_network_manual_override,
              style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceSecondary),
            ),
          ),
        SettingsSwitchListTile(
          enabled: automaticTransferEnabled,
          valueNotifier: automaticTransfer,
          title: context.t.automatic_local_network_transfer_title,
          subtitle: context.t.automatic_local_network_transfer_subtitle,
          onChanged: (value) => unawaited(saveAutomaticTransfer(value)),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: Card(
            elevation: 0,
            shape: RoundedRectangleBorder(
              borderRadius: const BorderRadius.all(Radius.circular(16)),
              side: BorderSide(color: context.colorScheme.surfaceContainerHighest, width: 1),
            ),
            child: ListTile(
              leading: isLan ? const Icon(Icons.lan_rounded, color: Colors.green) : const Icon(Icons.public_rounded),
              title: Text(
                isLan && routeUrl != null
                    ? context.t.local_network_status_connected(url: routeUrl)
                    : context.t.local_network_status_public,
                style: TextStyle(fontSize: 14, fontFamily: 'GoogleSansCode', color: context.primaryColor),
              ),
              subtitle: probeText == null ? null : Text(probeText),
            ),
          ),
        ),
        SwitchListTile.adaptive(
          contentPadding: const EdgeInsets.symmetric(horizontal: 20),
          dense: true,
          activeThumbColor: insecureEnabled ? context.primaryColor : context.themeData.disabledColor,
          value: allowInsecure.value,
          onChanged: insecureEnabled ? (value) => unawaited(handleAllowInsecureChanged(value)) : null,
          title: Text(
            context.t.allow_unencrypted_local_connections,
            style: context.textTheme.bodyLarge?.copyWith(
              fontWeight: FontWeight.w500,
              color: insecureEnabled ? null : context.themeData.disabledColor,
              height: 1.5,
            ),
          ),
          subtitle: Text(
            context.t.allow_unencrypted_local_connections_subtitle,
            style: context.textTheme.bodyMedium?.copyWith(
              color: insecureEnabled ? context.colorScheme.onSurfaceSecondary : context.themeData.disabledColor,
            ),
          ),
        ),
      ],
    );
  }
}
