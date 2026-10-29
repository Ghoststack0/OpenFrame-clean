import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/utils/device_transfer.utils.dart';
import 'package:openapi/api.dart';

void main() {
  group('deviceTransferIcon', () {
    test('uses a phone icon for mobile operating systems', () {
      expect(deviceTransferIcon(deviceType: 'Immich_Android', deviceOS: 'Android'), Icons.smartphone_rounded);
      expect(deviceTransferIcon(deviceType: 'Immich_iOS', deviceOS: 'iOS'), Icons.smartphone_rounded);
    });

    test('uses a computer icon for desktop operating systems', () {
      expect(deviceTransferIcon(deviceType: 'Firefox', deviceOS: 'Linux'), Icons.computer_rounded);
      expect(deviceTransferIcon(deviceType: 'Chrome', deviceOS: 'Windows'), Icons.computer_rounded);
      expect(deviceTransferIcon(deviceType: 'Safari', deviceOS: 'macOS'), Icons.computer_rounded);
    });

    test('falls back to generic icons', () {
      expect(deviceTransferIcon(deviceType: 'Unknown', deviceOS: 'Plan 9'), Icons.language_rounded);
      expect(deviceTransferIcon(deviceType: '', deviceOS: ''), Icons.devices_rounded);
    });
  });

  group('deviceTransferFailure', () {
    test('maps the documented statuses', () {
      expect(deviceTransferFailure(ApiException(404, '')), DeviceTransferFailure.unavailable);
      expect(deviceTransferFailure(ApiException(409, '')), DeviceTransferFailure.offline);
      expect(deviceTransferFailure(ApiException(400, '')), DeviceTransferFailure.invalid);
      expect(deviceTransferFailure(ApiException(500, '')), DeviceTransferFailure.unknown);
      expect(deviceTransferFailure(StateError('boom')), DeviceTransferFailure.unknown);
    });
  });
}
