import 'package:flutter/material.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/utils/pairing_failure.dart';
import 'package:immich_ui/immich_ui.dart';

/// Shows the server a scanned QR code points at and redeems it only after the user confirms.
///
/// [onConnect] must throw on failure. The sheet closes with `true` on success.
/// The code itself is never shown; only the candidate [serverUrls] are.
class PairingConfirmSheet extends StatefulWidget {
  final List<String> serverUrls;
  final Future<void> Function(String serverUrl) onConnect;

  const PairingConfirmSheet({super.key, required this.serverUrls, required this.onConnect});

  static Future<bool> show(
    BuildContext context, {
    required List<String> serverUrls,
    required Future<void> Function(String serverUrl) onConnect,
  }) async {
    final result = await showModalBottomSheet<bool>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      // The code may already be consumed once a request is in flight, so only the buttons dismiss the sheet.
      isDismissible: false,
      enableDrag: false,
      builder: (_) => PairingConfirmSheet(serverUrls: serverUrls, onConnect: onConnect),
    );
    return result ?? false;
  }

  @override
  State<PairingConfirmSheet> createState() => _PairingConfirmSheetState();
}

class _PairingConfirmSheetState extends State<PairingConfirmSheet> {
  late String _selected = widget.serverUrls.first;
  bool _connecting = false;
  PairingFailure? _failure;

  Future<void> _connect() async {
    setState(() {
      _connecting = true;
      _failure = null;
    });
    try {
      await widget.onConnect(_selected);
      if (mounted) {
        Navigator.of(context).pop(true);
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          _connecting = false;
          _failure = pairingFailureFrom(error);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final theme = context.themeData;
    final colors = context.colorScheme;
    final isInsecure = Uri.tryParse(_selected)?.scheme == 'http';

    return PopScope(
      canPop: !_connecting,
      child: SafeArea(
        child: SingleChildScrollView(
          padding: EdgeInsets.fromLTRB(
            ImmichSpacing.xl,
            0,
            ImmichSpacing.xl,
            ImmichSpacing.xl + MediaQuery.viewInsetsOf(context).bottom,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(header: true, child: Text(t.qr_login_confirm_title, style: theme.textTheme.titleLarge)),
              const SizedBox(height: ImmichSpacing.sm),
              Text(t.qr_login_confirm_description, style: theme.textTheme.bodyMedium),
              const SizedBox(height: ImmichSpacing.lg),
              Text(
                widget.serverUrls.length > 1 ? t.qr_login_server_choose : t.qr_login_server,
                style: theme.textTheme.labelLarge?.copyWith(color: colors.primary),
              ),
              const SizedBox(height: ImmichSpacing.xs),
              if (widget.serverUrls.length == 1)
                _ServerTile(url: widget.serverUrls.single)
              else
                RadioGroup<String>(
                  groupValue: _selected,
                  onChanged: (value) {
                    if (!_connecting && value != null) {
                      setState(() {
                        _selected = value;
                        _failure = null;
                      });
                    }
                  },
                  child: Column(
                    children: [
                      for (final url in widget.serverUrls)
                        RadioListTile<String>(
                          value: url,
                          enabled: !_connecting,
                          contentPadding: EdgeInsets.zero,
                          title: Text(url, style: _serverStyle(theme)),
                        ),
                    ],
                  ),
                ),
              if (isInsecure) ...[
                const SizedBox(height: ImmichSpacing.md),
                _Notice(icon: Icons.lock_open_rounded, text: t.qr_login_http_warning, isError: false),
              ],
              if (_failure != null) ...[
                const SizedBox(height: ImmichSpacing.md),
                Semantics(
                  liveRegion: true,
                  child: _Notice(icon: Icons.error_outline_rounded, text: _failure!.message(t), isError: true),
                ),
              ],
              const SizedBox(height: ImmichSpacing.xl),
              ImmichTextButton(
                labelText: t.qr_login_connect,
                icon: Icons.link_rounded,
                loading: _connecting,
                onPressed: _connect,
              ),
              const SizedBox(height: ImmichSpacing.sm),
              ImmichTextButton(
                labelText: t.cancel,
                variant: ImmichVariant.ghost,
                disabled: _connecting,
                onPressed: () => Navigator.of(context).pop(false),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

TextStyle? _serverStyle(ThemeData theme) => theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600);

class _ServerTile extends StatelessWidget {
  final String url;

  const _ServerTile({required this.url});

  @override
  Widget build(BuildContext context) {
    final theme = context.themeData;
    return Container(
      padding: const EdgeInsets.all(ImmichSpacing.md),
      decoration: BoxDecoration(
        color: context.colorScheme.surfaceContainerHigh,
        borderRadius: const BorderRadius.all(Radius.circular(12)),
      ),
      child: Row(
        children: [
          Icon(Icons.dns_outlined, color: context.colorScheme.primary),
          const SizedBox(width: ImmichSpacing.md),
          Expanded(child: Text(url, style: _serverStyle(theme))),
        ],
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  final IconData icon;
  final String text;
  final bool isError;

  const _Notice({required this.icon, required this.text, required this.isError});

  @override
  Widget build(BuildContext context) {
    final colors = context.colorScheme;
    final background = isError ? colors.errorContainer : colors.surfaceContainerHigh;
    final foreground = isError ? colors.onErrorContainer : colors.onSurface;
    return Container(
      padding: const EdgeInsets.all(ImmichSpacing.md),
      decoration: BoxDecoration(color: background, borderRadius: const BorderRadius.all(Radius.circular(12))),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: foreground, size: ImmichIconSize.md),
          const SizedBox(width: ImmichSpacing.sm),
          Expanded(
            child: Text(text, style: TextStyle(color: foreground)),
          ),
        ],
      ),
    );
  }
}
