import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/config/app_config.dart';
import 'package:immich_mobile/domain/models/settings_key.dart';

void main() {
  test('legacy network settings retain manual routing and default to secure automatic discovery', () {
    final legacy = AppConfig.fromEntries({
      SettingsKey.networkAutoEndpointSwitching: true,
      SettingsKey.networkPreferredWifiName: 'Home',
      SettingsKey.networkLocalEndpoint: 'http://192.168.1.2:2283',
    });
    expect(legacy.network.autoEndpointSwitching, isTrue);
    expect(legacy.network.automaticLanTransfer, isTrue);
    expect(legacy.network.allowInsecureLanTransfer, isFalse);
    final updated = legacy
        .write(SettingsKey.networkAutomaticLanTransfer, false)
        .write(SettingsKey.networkAllowInsecureLanTransfer, true);
    expect(updated.network.automaticLanTransfer, isFalse);
    expect(updated.network.allowInsecureLanTransfer, isTrue);
    expect(updated.network.preferredWifiName, 'Home');
    expect(updated.network.localEndpoint, 'http://192.168.1.2:2283');
  });

  group('SettingsKey', () {
    for (final key in SettingsKey.values) {
      final defaultValue = defaultConfig.read(key);
      // null is a valid value for some keys but we don't use the codec in that case
      if (defaultValue == null) {
        continue;
      }
      test('verify codec for $key', () {
        final encoded = key.encode(defaultValue);
        final decoded = key.decode(encoded);
        expect(decoded, defaultValue, reason: 'round-trip failed for ${key.name}');
      });
    }
  });
}
