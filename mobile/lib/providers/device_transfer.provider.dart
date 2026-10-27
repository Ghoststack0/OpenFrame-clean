import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/providers/websocket.provider.dart';
import 'package:immich_mobile/services/device_transfer.service.dart';
import 'package:openapi/api.dart';

final deviceTransferServiceProvider = Provider.autoDispose<DeviceTransferService>((ref) {
  final service = DeviceTransferService(ref.watch(apiServiceProvider).sessionsApi);
  ref.listen(
    websocketProvider.select((state) => state.socket),
    (_, socket) => service.attachSocket(socket),
    fireImmediately: true,
  );
  ref.onDispose(service.dispose);
  return service;
});

final deviceTransferIncomingProvider = StreamProvider.autoDispose<DeviceTransferResponseDto>((ref) {
  return ref.watch(deviceTransferServiceProvider).incoming;
});
