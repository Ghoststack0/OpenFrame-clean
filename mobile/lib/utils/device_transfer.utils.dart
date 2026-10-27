import 'package:flutter/material.dart';
import 'package:openapi/api.dart';

const deviceTransferMaxAssets = 100;

/// Picks an icon for a session using the same OS/browser hints as the authorized devices list.
IconData deviceTransferIcon({required String deviceType, required String deviceOS}) {
  final os = deviceOS.toLowerCase();
  if (os == 'android' || os == 'ios') {
    return Icons.smartphone_rounded;
  }
  if (os == 'chrome os' || os == 'google cast') {
    return Icons.cast_rounded;
  }
  if (os.contains('windows') || os.contains('linux') || os.contains('ubuntu') || os == 'macos') {
    return Icons.computer_rounded;
  }
  return deviceType.isEmpty && deviceOS.isEmpty ? Icons.devices_rounded : Icons.language_rounded;
}

enum DeviceTransferFailure { unavailable, offline, invalid, unknown }

/// Maps the send-to-device error statuses: 404 target gone, 409 target offline, 400 bad selection or no access.
DeviceTransferFailure deviceTransferFailure(Object error) {
  if (error is! ApiException) {
    return DeviceTransferFailure.unknown;
  }
  return switch (error.code) {
    404 => DeviceTransferFailure.unavailable,
    409 => DeviceTransferFailure.offline,
    400 => DeviceTransferFailure.invalid,
    _ => DeviceTransferFailure.unknown,
  };
}
