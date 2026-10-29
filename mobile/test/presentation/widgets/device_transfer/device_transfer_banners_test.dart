import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/services/asset.service.dart';
import 'package:immich_mobile/domain/services/timeline.service.dart';
import 'package:immich_mobile/domain/utils/background_sync.dart';
import 'package:immich_mobile/models/auth/auth_state.model.dart';
import 'package:immich_mobile/presentation/widgets/device_transfer/device_transfer_banners.widget.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/providers/device_transfer.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/repositories/download.repository.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/services/device_transfer.service.dart';
import 'package:immich_mobile/services/toast.service.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../../../widget_tester_extensions.dart';

class MockDeviceTransferService extends Mock implements DeviceTransferService {}

class MockAssetService extends Mock implements AssetService {}

class MockTimelineFactory extends Mock implements TimelineFactory {}

class MockTimelineService extends Mock implements TimelineService {}

class MockAppRouter extends Mock implements AppRouter {}

class MockDownloadRepository extends Mock implements DownloadRepository {}

class MockBackgroundSyncManager extends Mock implements BackgroundSyncManager {}

class FakeToastService implements ToastService {
  final errors = <String>[];

  @override
  FutureOr<void> success(String message, {ToastOption? toast}) {}

  @override
  FutureOr<void> error(String message, {ToastOption? toast}) {
    errors.add(message);
  }
}

class FakePageRouteInfo extends Fake implements PageRouteInfo {}

class FakeAuthNotifier extends StateNotifier<AuthState> with Fake implements AuthNotifier {
  FakeAuthNotifier(bool isAuthenticated)
    : super(
        AuthState(
          deviceId: 'device',
          userId: 'owner',
          userEmail: 'owner@example.com',
          isAuthenticated: isAuthenticated,
          name: 'Owner',
          isAdmin: false,
          profileImagePath: '',
        ),
      );
}

RemoteAsset _asset(String id) => RemoteAsset(
  id: id,
  name: '$id.jpg',
  ownerId: 'owner',
  checksum: 'checksum-$id',
  type: AssetType.image,
  createdAt: DateTime(2026),
  updatedAt: DateTime(2026),
  isEdited: false,
);

DeviceTransferResponseDto _transfer(String id, DeviceTransferAction action, List<String> assetIds) =>
    DeviceTransferResponseDto(
      id: id,
      sourceSessionId: 'source',
      targetSessionId: 'me',
      assetIds: assetIds,
      action: action,
      sentAt: DateTime(2026),
    );

void main() {
  late StreamController<DeviceTransferResponseDto> incoming;
  late MockDeviceTransferService transferService;
  late MockAssetService assetService;
  late MockAppRouter router;
  late MockTimelineFactory timelineFactory;
  late MockDownloadRepository downloads;
  late MockBackgroundSyncManager backgroundSync;
  late FakeToastService toast;

  setUpAll(() {
    registerFallbackValue(FakePageRouteInfo());
    registerFallbackValue(TimelineOrigin.deepLink);
    registerFallbackValue(<RemoteAsset>[]);
    registerFallbackValue(_asset('fallback'));
  });

  setUp(() {
    incoming = StreamController<DeviceTransferResponseDto>.broadcast();
    transferService = MockDeviceTransferService();
    assetService = MockAssetService();
    router = MockAppRouter();
    timelineFactory = MockTimelineFactory();
    downloads = MockDownloadRepository();
    backgroundSync = MockBackgroundSyncManager();
    toast = FakeToastService();

    when(() => transferService.listTargets()).thenAnswer(
      (_) async => [
        SessionTargetResponseDto(
          id: 'source',
          deviceType: 'Immich_Android',
          deviceOS: 'Android',
          deviceName: 'Immich_Android',
          label: 'Pixel (source)',
        ),
      ],
    );
    when(
      () => assetService.getRemoteAsset(any()),
    ).thenAnswer((invocation) async => _asset(invocation.positionalArguments.first as String));
    when(() => assetService.watchAsset(any())).thenAnswer((_) => const Stream.empty());
    when(() => router.push(any())).thenAnswer((_) async => null);
    when(() => timelineFactory.fromAssets(any(), any())).thenReturn(MockTimelineService());
    when(() => downloads.downloadAllAssets(any())).thenAnswer((_) async => []);
    when(() => backgroundSync.syncLocal()).thenAnswer((_) async {});
    when(() => backgroundSync.hashAssets()).thenAnswer((_) async {});
  });

  tearDown(() => incoming.close());

  Future<void> pumpBanners(WidgetTester tester, {bool authenticated = true}) async {
    await tester.pumpConsumerWidget(
      const DeviceTransferOverlay(child: Center(child: Text('app'))),
      overrides: [
        authProvider.overrideWith((ref) => FakeAuthNotifier(authenticated)),
        deviceTransferIncomingProvider.overrideWith((ref) => incoming.stream),
        deviceTransferServiceProvider.overrideWithValue(transferService),
        assetServiceProvider.overrideWithValue(assetService),
        appRouterProvider.overrideWithValue(router),
        timelineFactoryProvider.overrideWithValue(timelineFactory),
        downloadRepositoryProvider.overrideWithValue(downloads),
        backgroundSyncProvider.overrideWithValue(backgroundSync),
        toastServiceProvider.overrideWithValue(toast),
      ],
    );
  }

  testWidgets('shows nothing and does not listen while signed out', (tester) async {
    await pumpBanners(tester, authenticated: false);
    incoming.add(_transfer('t1', DeviceTransferAction.open, ['a']));
    await tester.pumpAndSettle();

    expect(find.text('app'), findsOneWidget);
    expect(find.textContaining('sent you'), findsNothing);
  });

  testWidgets('announces an incoming open transfer without acting on it', (tester) async {
    await pumpBanners(tester);
    incoming.add(_transfer('t1', DeviceTransferAction.open, ['a', 'b', 'c']));
    await tester.pumpAndSettle();

    expect(find.text('Pixel (source) sent you 3 photos'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Open'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Download'), findsNothing);
    verifyNever(() => assetService.getRemoteAsset(any()));
    verifyNever(() => router.push(any()));
    verifyNever(() => downloads.downloadAllAssets(any()));
  });

  testWidgets('falls back to a generic name when the source cannot be resolved', (tester) async {
    when(() => transferService.listTargets()).thenAnswer((_) async => []);
    await pumpBanners(tester);
    incoming.add(_transfer('t1', DeviceTransferAction.open, ['a']));
    await tester.pumpAndSettle();

    expect(find.text('Another device sent you 1 photo'), findsOneWidget);
  });

  testWidgets('opens the viewer for the sent assets only after tapping Open', (tester) async {
    await pumpBanners(tester);
    incoming.add(_transfer('t1', DeviceTransferAction.open, ['a', 'b']));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Open'));
    await tester.pumpAndSettle();

    verify(() => assetService.getRemoteAsset('a')).called(1);
    verify(() => assetService.getRemoteAsset('b')).called(1);
    final assets = verify(() => timelineFactory.fromAssets(captureAny(), TimelineOrigin.deepLink)).captured.single;
    expect((assets as List<BaseAsset>).map((asset) => asset.id), ['a', 'b']);
    final route = verify(() => router.push(captureAny())).captured.single;
    expect(route, isA<AssetViewerRoute>());
    expect(find.textContaining('sent you'), findsNothing);
  });

  testWidgets('tells the user when the sent assets are not available yet', (tester) async {
    when(() => assetService.getRemoteAsset(any())).thenAnswer((_) async => null);
    await pumpBanners(tester);
    incoming.add(_transfer('t1', DeviceTransferAction.open, ['a']));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Open'));
    await tester.pumpAndSettle();

    verifyNever(() => router.push(any()));
    expect(toast.errors, ["Couldn't find the sent items. They may not have synced to this device yet."]);
  });

  testWidgets('downloads the sent assets only after tapping Download', (tester) async {
    await pumpBanners(tester);
    incoming.add(_transfer('t1', DeviceTransferAction.download, ['a', 'b']));
    await tester.pumpAndSettle();

    verifyNever(() => downloads.downloadAllAssets(any()));
    await tester.tap(find.widgetWithText(FilledButton, 'Download'));
    await tester.pump(const Duration(seconds: 2));

    final assets = verify(() => downloads.downloadAllAssets(captureAny())).captured.single;
    expect((assets as List<RemoteAsset>).map((asset) => asset.id), ['a', 'b']);
    verifyNever(() => router.push(any()));
    expect(find.textContaining('sent you'), findsNothing);
  });

  testWidgets('dismisses a banner without acting on it', (tester) async {
    await pumpBanners(tester);
    incoming.add(_transfer('t1', DeviceTransferAction.open, ['a']));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Dismiss'));
    await tester.pumpAndSettle();

    expect(find.textContaining('sent you'), findsNothing);
    verifyNever(() => assetService.getRemoteAsset(any()));
    verifyNever(() => router.push(any()));
    verifyNever(() => downloads.downloadAllAssets(any()));
  });

  testWidgets('stacks several transfers and can dismiss them all', (tester) async {
    await pumpBanners(tester);
    incoming.add(_transfer('t1', DeviceTransferAction.open, ['a']));
    incoming.add(_transfer('t2', DeviceTransferAction.download, ['b', 'c']));
    await tester.pumpAndSettle();

    expect(find.textContaining('sent you'), findsNWidgets(2));
    expect(find.text('Pixel (source) sent you 2 photos'), findsOneWidget);

    await tester.tap(find.text('Dismiss all'));
    await tester.pumpAndSettle();

    expect(find.textContaining('sent you'), findsNothing);
    verifyNever(() => downloads.downloadAllAssets(any()));
  });
}
