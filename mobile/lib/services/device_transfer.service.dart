import 'dart:async';

import 'package:immich_mobile/repositories/api.repository.dart';
import 'package:logging/logging.dart';
import 'package:openapi/api.dart';
import 'package:socket_io_client/socket_io_client.dart';

class DeviceTransferService extends ApiRepository {
  DeviceTransferService(this._api);

  final SessionsApi _api;
  final _incoming = StreamController<DeviceTransferResponseDto>.broadcast();
  final _log = Logger('DeviceTransferService');
  Socket? _socket;

  Stream<DeviceTransferResponseDto> get incoming => _incoming.stream;

  Future<List<SessionTargetResponseDto>> listTargets() => checkNull(_api.getDeviceTargets());

  Future<DeviceTransferResponseDto> send({
    required String targetSessionId,
    required List<String> assetIds,
    required DeviceTransferAction action,
  }) => checkNull(
    _api.sendToDevice(DeviceTransferDto(targetSessionId: targetSessionId, assetIds: assetIds, action: action)),
  );

  void attachSocket(Socket? socket) {
    if (identical(_socket, socket)) {
      return;
    }
    _socket?.off('on_device_transfer', _receive);
    _socket = socket;
    _socket?.on('on_device_transfer', _receive);
  }

  void _receive(dynamic data) {
    try {
      final payload = DeviceTransferResponseDto.fromJson(data);
      if (payload != null && payload.assetIds.isNotEmpty && payload.assetIds.length <= 100) {
        _incoming.add(payload);
      }
    } catch (error) {
      _log.warning('Invalid device transfer event', error);
    }
  }

  void dispose() {
    attachSocket(null);
    unawaited(_incoming.close());
  }
}
