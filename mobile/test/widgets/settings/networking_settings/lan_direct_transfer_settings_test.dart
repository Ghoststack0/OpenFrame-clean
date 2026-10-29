import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/config/app_config.dart';
import 'package:immich_mobile/domain/models/settings_key.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/providers/lan_direct_transfer.provider.dart';
import 'package:immich_mobile/widgets/settings/networking_settings/lan_direct_transfer_settings.dart';
import 'package:immich_ui/immich_ui.dart';
import 'package:mocktail/mocktail.dart';

import '../../../infrastructure/repository.mock.dart';
import '../../../widget_tester_extensions.dart';

class MockAuthNotifier extends Mock implements AuthNotifier {}

const _insecureTitle = 'Allow unencrypted (HTTP) local connections';

void main() {
  late MockSettingsRepository settings;
  late MockAuthNotifier authNotifier;

  setUpAll(() {
    registerFallbackValue(SettingsKey.networkAllowInsecureLanTransfer);
  });

  setUp(() {
    settings = MockSettingsRepository();
    authNotifier = MockAuthNotifier();
    when(() => settings.write<bool, bool>(any(), any())).thenAnswer((_) async {});
    when(() => authNotifier.setOpenApiServiceEndpoint()).thenAnswer((_) async => null);
  });

  Future<void> pump(
    WidgetTester tester, {
    LanRouteState route = const LanRouteState(),
    bool manualSwitchingEnabled = false,
  }) {
    return tester.pumpConsumerWidget(
      LanDirectTransferSettings(manualSwitchingEnabled: manualSwitchingEnabled),
      overrides: [
        settingsProvider.overrideWithValue(settings),
        appConfigProvider.overrideWithValue(const AppConfig()),
        lanDirectTransferProvider.overrideWith((_) => route),
        authProvider.overrideWith((_) => authNotifier),
      ],
    );
  }

  Finder insecureSwitch() => find.widgetWithText(SwitchListTile, _insecureTitle);

  testWidgets('shows the verified local URL without the api suffix', (tester) async {
    await pump(
      tester,
      route: const LanRouteState(
        route: LanRoute.lan,
        url: 'https://photos.home.example/api',
        lastProbeResult: LanProbeResult.verified,
      ),
    );

    expect(find.text('Connected directly over local network (https://photos.home.example)'), findsOneWidget);
    expect(find.text("The server's identity was verified on this network."), findsOneWidget);
  });

  testWidgets('shows the public address with a message for each probe result', (tester) async {
    const messages = <LanProbeResult, String?>{
      LanProbeResult.idle: 'Checking for a local address...',
      LanProbeResult.noCandidates:
          'The server has no local addresses configured. An admin can add them in the server settings.',
      LanProbeResult.unreachable: 'The local address did not respond, so the public address is used.',
      LanProbeResult.identityMismatch: 'The local address belongs to a different server, so it was not used.',
      LanProbeResult.insecureHttpRefused:
          'Local connections over unencrypted HTTP are blocked. Allow them below to use a local address.',
      LanProbeResult.discoveryFailed: 'Could not check for a local address, so the public address is used.',
      LanProbeResult.disabled: 'Automatic local network transfer is turned off.',
      LanProbeResult.manualOverride: null,
    };

    for (final entry in messages.entries) {
      // Overrides apply only when ProviderScope mounts, so unmount between results.
      await tester.pumpWidget(const SizedBox());
      await pump(
        tester,
        route: LanRouteState(url: 'https://photos.home.example/api', lastProbeResult: entry.key),
      );

      expect(find.text('Using public address'), findsOneWidget, reason: entry.key.name);
      if (entry.value != null) {
        expect(find.text(entry.value!), findsOneWidget, reason: entry.key.name);
      }
    }
  });

  testWidgets('manual URL switching overrides and disables automatic transfer', (tester) async {
    await pump(tester, manualSwitchingEnabled: true);

    expect(
      find.text('Automatic URL switching is on and takes precedence, so automatic local network transfer is not used.'),
      findsOneWidget,
    );
    expect(tester.widget<SettingsSwitchListTile>(find.byType(SettingsSwitchListTile)).enabled, isFalse);
    expect(tester.widget<SwitchListTile>(insecureSwitch()).onChanged, isNull);
  });

  testWidgets('keeps unencrypted local connections off when the confirmation is cancelled', (tester) async {
    await pump(tester);

    await tester.tap(find.text(_insecureTitle));
    await tester.pumpAndSettle();

    expect(find.text('Allow unencrypted connections?'), findsOneWidget);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(find.text('Allow unencrypted connections?'), findsNothing);
    expect(tester.widget<SwitchListTile>(insecureSwitch()).value, isFalse);
    verifyNever(() => settings.write<bool, bool>(SettingsKey.networkAllowInsecureLanTransfer, true));
    verifyNever(() => authNotifier.setOpenApiServiceEndpoint());
  });

  testWidgets('turns unencrypted local connections on only after confirmation', (tester) async {
    await pump(tester);

    await tester.tap(find.text(_insecureTitle));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Enable'));
    await tester.pumpAndSettle();

    expect(tester.widget<SwitchListTile>(insecureSwitch()).value, isTrue);
    verify(() => settings.write<bool, bool>(SettingsKey.networkAllowInsecureLanTransfer, true)).called(1);
    verify(() => authNotifier.setOpenApiServiceEndpoint()).called(1);
  });
}
