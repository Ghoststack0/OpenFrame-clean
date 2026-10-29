import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/services/device_transfer.service.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';
import 'package:socket_io_client/socket_io_client.dart';

class MockSessionsApi extends Mock implements SessionsApi {}

class MockSocket extends Mock implements Socket {}

void main() {
  late MockSessionsApi api;
  late MockSocket socket;
  late DeviceTransferService service;
  late void Function(dynamic) receive;
  final json = <String, dynamic>{
    'id': 'd1611ff9-9123-40af-8e9c-4c1f121e2ac3',
    'sourceSessionId': '83b24478-c4e5-40e4-944d-685d7dd3da15',
    'targetSessionId': '08b24478-c4e5-40e4-944d-685d7dd3da15',
    'assetIds': ['dbfb9f73-53d3-4b05-8b08-636678370427'],
    'action': 'open',
    'sentAt': '2026-10-28T00:00:00.000Z',
  };

  setUpAll(() {
    registerFallbackValue(DeviceTransferDto(targetSessionId: 'target', action: DeviceTransferAction.open));
  });

  setUp(() {
    api = MockSessionsApi();
    socket = MockSocket();
    when(() => socket.on('on_device_transfer', any())).thenAnswer((invocation) {
      receive = invocation.positionalArguments[1] as void Function(dynamic);
      return () {};
    });
    service = DeviceTransferService(api);
    service.attachSocket(socket);
  });

  tearDown(() => service.dispose());

  test('lists the online targets', () async {
    final targets = [
      SessionTargetResponseDto(
        id: 'target',
        deviceType: 'Chrome',
        deviceOS: 'Linux',
        deviceName: 'Chrome',
        label: 'Chrome on Linux',
      ),
    ];
    when(() => api.getDeviceTargets()).thenAnswer((_) async => targets);
    expect(await service.listTargets(), targets);
  });

  test('sends a selection using the generated API', () async {
    final payload = DeviceTransferResponseDto.fromJson(Map<String, dynamic>.from(json))!;
    when(() => api.sendToDevice(any())).thenAnswer((_) async => payload);
    expect(
      await service.send(
        targetSessionId: payload.targetSessionId,
        assetIds: payload.assetIds,
        action: DeviceTransferAction.open,
      ),
      payload,
    );
    final dto = verify(() => api.sendToDevice(captureAny())).captured.single as DeviceTransferDto;
    expect(dto.targetSessionId, payload.targetSessionId);
    expect(dto.assetIds, payload.assetIds);
    expect(dto.action, DeviceTransferAction.open);
  });

  test('propagates an offline target error', () async {
    when(() => api.sendToDevice(any())).thenAnswer((_) async => throw ApiException(409, 'Target session is offline'));
    await expectLater(
      service.send(targetSessionId: 'target', assetIds: ['asset'], action: DeviceTransferAction.download),
      throwsA(isA<ApiException>()),
    );
  });

  test('exposes incoming payloads as a broadcast stream', () async {
    final first = service.incoming.first;
    final second = service.incoming.first;
    receive(Map<String, dynamic>.from(json));
    expect((await first).assetIds, json['assetIds']);
    expect((await second).action, DeviceTransferAction.open);
  });

  test('ignores malformed events and keeps listening', () async {
    final next = service.incoming.first;
    receive(null);
    receive({'action': 'invalid'});
    receive({...json, 'assetIds': <String>[]});
    receive({...json, 'assetIds': List.filled(101, 'asset')});
    receive({...json, 'action': 'download'});
    expect((await next).action, DeviceTransferAction.download);
  });

  test('moves the listener when the existing socket is replaced', () {
    final nextSocket = MockSocket();
    when(() => nextSocket.on('on_device_transfer', any())).thenReturn(() {});
    service.attachSocket(socket);
    verify(() => socket.on('on_device_transfer', any())).called(1);
    service.attachSocket(nextSocket);
    verify(() => socket.off('on_device_transfer', any())).called(1);
    verify(() => nextSocket.on('on_device_transfer', any())).called(1);
    service.attachSocket(null);
    verify(() => nextSocket.off('on_device_transfer', any())).called(1);
  });

  test('detaches without closing the shared socket', () async {
    final done = expectLater(service.incoming, emitsDone);
    service.dispose();
    verify(() => socket.off('on_device_transfer', any())).called(1);
    verifyNever(() => socket.dispose());
    await done;
  });
}
