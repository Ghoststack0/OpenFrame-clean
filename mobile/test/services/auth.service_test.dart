import 'dart:async';

import 'package:drift/drift.dart' hide isNull;
import 'package:drift/native.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/models/auth/auxilary_endpoint.model.dart';
import 'package:immich_mobile/services/auth.service.dart';
import 'package:immich_mobile/services/lan_direct_transfer.service.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../repository.mocks.dart';
import '../service.mocks.dart';

class MockLanDirectTransferService extends Mock implements LanDirectTransferService {}

void main() {
  late AuthService sut;
  late MockAuthApiRepository authApiRepository;
  late MockAuthRepository authRepository;
  late MockApiService apiService;
  late MockNetworkService networkService;
  late MockBackgroundSyncManager backgroundSyncManager;
  late Drift db;

  setUp(() async {
    authApiRepository = MockAuthApiRepository();
    authRepository = MockAuthRepository();
    apiService = MockApiService();
    networkService = MockNetworkService();
    backgroundSyncManager = MockBackgroundSyncManager();
    sut = AuthService(authApiRepository, authRepository, apiService, networkService, backgroundSyncManager);

    registerFallbackValue(Uri());
  });

  setUpAll(() async {
    WidgetsFlutterBinding.ensureInitialized();
    db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await StoreService.init(storeRepository: StoreRepository(db));
  });

  tearDownAll(() async {
    await db.close();
  });

  group('validateServerUrl', () {
    test('Should resolve HTTP endpoint', () async {
      const testUrl = 'http://ip:2283';
      const resolvedUrl = 'http://ip:2283/api';

      when(() => apiService.resolveAndSetEndpoint(testUrl)).thenAnswer((_) async => resolvedUrl);
      when(() => apiService.setDeviceInfoHeader()).thenAnswer((_) async => {});

      final result = await sut.validateServerUrl(testUrl);

      expect(result, resolvedUrl);

      verify(() => apiService.resolveAndSetEndpoint(testUrl)).called(1);
      verify(() => apiService.setDeviceInfoHeader()).called(1);
    });

    test('Should resolve HTTPS endpoint', () async {
      const testUrl = 'https://immich.domain.com';
      const resolvedUrl = 'https://immich.domain.com/api';

      when(() => apiService.resolveAndSetEndpoint(testUrl)).thenAnswer((_) async => resolvedUrl);
      when(() => apiService.setDeviceInfoHeader()).thenAnswer((_) async => {});

      final result = await sut.validateServerUrl(testUrl);

      expect(result, resolvedUrl);

      verify(() => apiService.resolveAndSetEndpoint(testUrl)).called(1);
      verify(() => apiService.setDeviceInfoHeader()).called(1);
    });

    test('Should throw error on invalid URL', () async {
      const testUrl = 'invalid-url';

      when(() => apiService.resolveAndSetEndpoint(testUrl)).thenThrow(Exception('Invalid URL'));

      expect(() async => await sut.validateServerUrl(testUrl), throwsA(isA<Exception>()));

      verify(() => apiService.resolveAndSetEndpoint(testUrl)).called(1);
      verifyNever(() => apiService.setDeviceInfoHeader());
    });

    test('Should throw error on unreachable server', () async {
      const testUrl = 'https://unreachable.server';

      when(() => apiService.resolveAndSetEndpoint(testUrl)).thenThrow(Exception('Server is not reachable'));

      expect(() async => await sut.validateServerUrl(testUrl), throwsA(isA<Exception>()));

      verify(() => apiService.resolveAndSetEndpoint(testUrl)).called(1);
      verifyNever(() => apiService.setDeviceInfoHeader());
    });
  });

  group('automatic LAN endpoint integration', () {
    late MockLanDirectTransferService lan;
    late List<LanRouteState> states;
    const publicUrl = 'https://public.example/api';
    const lanUrl = 'https://photos.lan/api';
    const verified = LanRouteState(route: LanRoute.lan, url: lanUrl, lastProbeResult: LanProbeResult.verified);
    const fallback = LanRouteState(url: publicUrl, lastProbeResult: LanProbeResult.discoveryFailed);

    setUp(() async {
      lan = MockLanDirectTransferService();
      states = [];
      sut = AuthService(
        authApiRepository,
        authRepository,
        apiService,
        networkService,
        backgroundSyncManager,
        lanDirectTransferService: lan,
        onLanRouteChanged: states.add,
      );
      await Store.put(StoreKey.serverUrl, publicUrl);
      await Store.put(StoreKey.accessToken, 'token');
      when(() => authRepository.getEndpointSwitchingFeature()).thenReturn(false);
      when(() => authRepository.getAutomaticLanTransfer()).thenReturn(true);
      when(() => authRepository.getAllowInsecureLanTransfer()).thenReturn(false);
      when(() => apiService.activateEndpoint(any())).thenAnswer((_) async {});
      when(() => lan.select(publicUrl: publicUrl, allowInsecureHttp: false)).thenAnswer((_) async => verified);
    });

    tearDown(() async {
      await Store.delete(StoreKey.serverUrl);
      await Store.delete(StoreKey.accessToken);
    });

    test('activates a verified endpoint through the shared API service and exposes state', () async {
      expect(await sut.setOpenApiServiceEndpoint(), lanUrl);
      verify(() => apiService.activateEndpoint(lanUrl)).called(1);
      expect(states.last.route, LanRoute.lan);
      expect(Store.get(StoreKey.serverUrl), publicUrl);
      verifyNever(() => networkService.getWifiName());
    });

    test('restores the public URL on discovery failure', () async {
      when(() => lan.select(publicUrl: publicUrl, allowInsecureHttp: false)).thenAnswer((_) async => fallback);
      expect(await sut.setOpenApiServiceEndpoint(), publicUrl);
      verify(() => apiService.activateEndpoint(publicUrl)).called(1);
      expect(states.last.lastProbeResult, LanProbeResult.discoveryFailed);
    });

    test('restores the public URL when automatic LAN transfer is disabled', () async {
      when(() => authRepository.getAutomaticLanTransfer()).thenReturn(false);
      expect(await sut.setOpenApiServiceEndpoint(), publicUrl);
      verifyNever(() => lan.select(publicUrl: publicUrl));
      expect(states.last.lastProbeResult, LanProbeResult.disabled);
    });

    test('keeps the manual SSID override when it disagrees with automatic discovery', () async {
      when(() => authRepository.getEndpointSwitchingFeature()).thenReturn(true);
      when(() => networkService.getWifiName()).thenAnswer((_) async => 'OtherWifi');
      when(() => authRepository.getPreferredWifiName()).thenReturn('HomeWifi');
      when(
        () => authRepository.getExternalEndpointList(),
      ).thenReturn([const AuxilaryEndpoint(url: publicUrl, status: AuxCheckStatus.valid)]);
      when(() => apiService.resolveAndSetEndpoint(publicUrl)).thenAnswer((_) async => publicUrl);
      expect(await sut.setOpenApiServiceEndpoint(), publicUrl);
      verifyNever(() => lan.select(publicUrl: publicUrl));
      expect(states.last.lastProbeResult, LanProbeResult.manualOverride);
    });

    test('discards an in-flight probe after a network change and reruns selection', () async {
      final pending = Completer<LanRouteState>();
      var calls = 0;
      when(() => lan.select(publicUrl: publicUrl, allowInsecureHttp: false)).thenAnswer((_) {
        calls++;
        return calls == 1 ? pending.future : Future.value(fallback);
      });
      final first = sut.setOpenApiServiceEndpoint();
      await Future<void>.delayed(Duration.zero);
      final second = sut.setOpenApiServiceEndpoint();
      pending.complete(verified);
      expect(await first, publicUrl);
      expect(await second, publicUrl);
      verifyNever(() => apiService.activateEndpoint(lanUrl));
      verify(() => apiService.activateEndpoint(publicUrl)).called(2);
    });

    test('does not activate a probe after logout', () async {
      final pending = Completer<LanRouteState>();
      when(() => lan.select(publicUrl: publicUrl, allowInsecureHttp: false)).thenAnswer((_) => pending.future);
      final operation = sut.setOpenApiServiceEndpoint();
      await Future<void>.delayed(Duration.zero);
      await Store.delete(StoreKey.accessToken);
      pending.complete(verified);
      expect(await operation, isNull);
      verifyNever(() => apiService.activateEndpoint(lanUrl));
      expect(states.last.route, LanRoute.public);
    });

    test('does not rerun a probe while logout waits for background cancellation', () async {
      final pending = Completer<LanRouteState>();
      final cancellation = Completer<void>();
      when(() => lan.select(publicUrl: publicUrl, allowInsecureHttp: false)).thenAnswer((_) => pending.future);
      when(() => backgroundSyncManager.cancel()).thenAnswer((_) => cancellation.future);
      final operation = sut.setOpenApiServiceEndpoint();
      await Future<void>.delayed(Duration.zero);
      final clearing = sut.clearLocalData();
      pending.complete(verified);
      expect(await operation, isNull);
      verifyNever(() => apiService.activateEndpoint(lanUrl));
      verify(() => lan.select(publicUrl: publicUrl, allowInsecureHttp: false)).called(1);
      final assertion = expectLater(clearing, throwsStateError);
      cancellation.completeError(StateError('cancellation failed'));
      await assertion;
    });

    test('discards probes after disposal', () async {
      final pending = Completer<LanRouteState>();
      when(() => lan.select(publicUrl: publicUrl, allowInsecureHttp: false)).thenAnswer((_) => pending.future);
      final operation = sut.setOpenApiServiceEndpoint();
      await Future<void>.delayed(Duration.zero);
      sut.dispose();
      pending.complete(verified);
      expect(await operation, isNull);
      verifyNever(() => apiService.activateEndpoint(lanUrl));
    });

    test('does not publish a LAN route after disposal during endpoint activation', () async {
      final activation = Completer<void>();
      when(() => apiService.activateEndpoint(lanUrl)).thenAnswer((_) => activation.future);
      final operation = sut.setOpenApiServiceEndpoint();
      await Future<void>.delayed(Duration.zero);
      sut.dispose();
      activation.complete();
      expect(await operation, isNull);
      expect(states.last.route, LanRoute.public);
    });
  });

  group('setOpenApiServiceEndpoint', () {
    setUp(() {
      when(() => networkService.getWifiName()).thenAnswer((_) async => 'TestWifi');
    });

    test('Should return null if auto endpoint switching is disabled', () async {
      when(() => authRepository.getEndpointSwitchingFeature()).thenReturn(false);

      final result = await sut.setOpenApiServiceEndpoint();

      expect(result, isNull);
      verify(() => authRepository.getEndpointSwitchingFeature()).called(1);
      verifyNever(() => networkService.getWifiName());
    });

    test('Should set local connection if wifi name matches', () async {
      when(() => authRepository.getEndpointSwitchingFeature()).thenReturn(true);
      when(() => authRepository.getPreferredWifiName()).thenReturn('TestWifi');
      when(() => authRepository.getLocalEndpoint()).thenReturn('http://local.endpoint');
      when(
        () => apiService.resolveAndSetEndpoint('http://local.endpoint'),
      ).thenAnswer((_) async => 'http://local.endpoint');

      final result = await sut.setOpenApiServiceEndpoint();

      expect(result, 'http://local.endpoint');
      verify(() => authRepository.getEndpointSwitchingFeature()).called(1);
      verify(() => networkService.getWifiName()).called(1);
      verify(() => authRepository.getPreferredWifiName()).called(1);
      verify(() => authRepository.getLocalEndpoint()).called(1);
      verify(() => apiService.resolveAndSetEndpoint('http://local.endpoint')).called(1);
    });

    test('Should set external endpoint if wifi name not matching', () async {
      when(() => authRepository.getEndpointSwitchingFeature()).thenReturn(true);
      when(() => authRepository.getPreferredWifiName()).thenReturn('DifferentWifi');
      when(
        () => authRepository.getExternalEndpointList(),
      ).thenReturn([const AuxilaryEndpoint(url: 'https://external.endpoint', status: AuxCheckStatus.valid)]);
      when(
        () => apiService.resolveAndSetEndpoint('https://external.endpoint'),
      ).thenAnswer((_) async => 'https://external.endpoint/api');

      final result = await sut.setOpenApiServiceEndpoint();

      expect(result, 'https://external.endpoint/api');
      verify(() => authRepository.getEndpointSwitchingFeature()).called(1);
      verify(() => networkService.getWifiName()).called(1);
      verify(() => authRepository.getPreferredWifiName()).called(1);
      verify(() => authRepository.getExternalEndpointList()).called(1);
      verify(() => apiService.resolveAndSetEndpoint('https://external.endpoint')).called(1);
    });

    test('Should set second external endpoint if the first throw any error', () async {
      when(() => authRepository.getEndpointSwitchingFeature()).thenReturn(true);
      when(() => authRepository.getPreferredWifiName()).thenReturn('DifferentWifi');
      when(() => authRepository.getExternalEndpointList()).thenReturn([
        const AuxilaryEndpoint(url: 'https://external.endpoint', status: AuxCheckStatus.valid),
        const AuxilaryEndpoint(url: 'https://external.endpoint2', status: AuxCheckStatus.valid),
      ]);

      when(
        () => apiService.resolveAndSetEndpoint('https://external.endpoint'),
      ).thenThrow(Exception('Invalid endpoint'));
      when(
        () => apiService.resolveAndSetEndpoint('https://external.endpoint2'),
      ).thenAnswer((_) async => 'https://external.endpoint2/api');

      final result = await sut.setOpenApiServiceEndpoint();

      expect(result, 'https://external.endpoint2/api');
      verify(() => authRepository.getEndpointSwitchingFeature()).called(1);
      verify(() => networkService.getWifiName()).called(1);
      verify(() => authRepository.getPreferredWifiName()).called(1);
      verify(() => authRepository.getExternalEndpointList()).called(1);
      verify(() => apiService.resolveAndSetEndpoint('https://external.endpoint2')).called(1);
    });

    test('Should set second external endpoint if the first throw ApiException', () async {
      when(() => authRepository.getEndpointSwitchingFeature()).thenReturn(true);
      when(() => authRepository.getPreferredWifiName()).thenReturn('DifferentWifi');
      when(() => authRepository.getExternalEndpointList()).thenReturn([
        const AuxilaryEndpoint(url: 'https://external.endpoint', status: AuxCheckStatus.valid),
        const AuxilaryEndpoint(url: 'https://external.endpoint2', status: AuxCheckStatus.valid),
      ]);

      when(
        () => apiService.resolveAndSetEndpoint('https://external.endpoint'),
      ).thenThrow(ApiException(503, 'Invalid endpoint'));
      when(
        () => apiService.resolveAndSetEndpoint('https://external.endpoint2'),
      ).thenAnswer((_) async => 'https://external.endpoint2/api');

      final result = await sut.setOpenApiServiceEndpoint();

      expect(result, 'https://external.endpoint2/api');
      verify(() => authRepository.getEndpointSwitchingFeature()).called(1);
      verify(() => networkService.getWifiName()).called(1);
      verify(() => authRepository.getPreferredWifiName()).called(1);
      verify(() => authRepository.getExternalEndpointList()).called(1);
      verify(() => apiService.resolveAndSetEndpoint('https://external.endpoint2')).called(1);
    });

    test('Should handle error when setting local connection', () async {
      when(() => authRepository.getEndpointSwitchingFeature()).thenReturn(true);
      when(() => authRepository.getPreferredWifiName()).thenReturn('TestWifi');
      when(() => authRepository.getLocalEndpoint()).thenReturn('http://local.endpoint');
      when(
        () => apiService.resolveAndSetEndpoint('http://local.endpoint'),
      ).thenThrow(Exception('Local endpoint error'));

      final result = await sut.setOpenApiServiceEndpoint();

      expect(result, isNull);
      verify(() => authRepository.getEndpointSwitchingFeature()).called(1);
      verify(() => networkService.getWifiName()).called(1);
      verify(() => authRepository.getPreferredWifiName()).called(1);
      verify(() => authRepository.getLocalEndpoint()).called(1);
      verify(() => apiService.resolveAndSetEndpoint('http://local.endpoint')).called(1);
    });

    test('Should handle error when setting external connection', () async {
      when(() => authRepository.getEndpointSwitchingFeature()).thenReturn(true);
      when(() => authRepository.getPreferredWifiName()).thenReturn('DifferentWifi');
      when(
        () => authRepository.getExternalEndpointList(),
      ).thenReturn([const AuxilaryEndpoint(url: 'https://external.endpoint', status: AuxCheckStatus.valid)]);
      when(
        () => apiService.resolveAndSetEndpoint('https://external.endpoint'),
      ).thenThrow(Exception('External endpoint error'));

      final result = await sut.setOpenApiServiceEndpoint();

      expect(result, isNull);
      verify(() => authRepository.getEndpointSwitchingFeature()).called(1);
      verify(() => networkService.getWifiName()).called(1);
      verify(() => authRepository.getPreferredWifiName()).called(1);
      verify(() => authRepository.getExternalEndpointList()).called(1);
      verify(() => apiService.resolveAndSetEndpoint('https://external.endpoint')).called(1);
    });
  });
}
