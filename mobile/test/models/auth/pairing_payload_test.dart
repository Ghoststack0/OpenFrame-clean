import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/models/auth/pairing_payload.model.dart';

void main() {
  final code = '11111111-1111-4111-8111-111111111111.${'A' * 43}';
  final servers = ['https://photos.example.com', 'http://192.168.1.9:2283', 'http://[::1]:2283'];
  String uri({String? token, List<String>? urls}) => Uri(
    scheme: 'openframe',
    host: 'pair',
    queryParameters: {'v': '1', 'server': urls ?? servers, 'code': token ?? code},
  ).toString();

  test('parses URI candidates in preference order including IPv6', () {
    final payload = PairingPayload.parse(uri());
    expect(payload.code, code);
    expect(payload.serverUrls, servers);
    expect(() => payload.serverUrls.add('https://other.example'), throwsUnsupportedError);
  });

  test('parses JSON, preserves subpaths, removes trailing slashes and duplicates', () {
    final payload = PairingPayload.parse(
      jsonEncode({
        'version': 1,
        'code': code,
        'serverUrls': ['https://photos.example.com/base/', 'https://photos.example.com/base'],
      }),
    );
    expect(payload.code, code);
    expect(payload.serverUrls, ['https://photos.example.com/base']);
  });

  test('rejects missing, malformed, or short bearer codes', () {
    for (final token in ['', 'password', '$code.extra', '${'x' * 36}.${'A' * 43}']) {
      expect(() => PairingPayload.parse(uri(token: token)), throwsFormatException);
    }
  });

  test('rejects unsupported envelopes and duplicate security parameters', () {
    for (final input in [
      '',
      'https://example.com',
      'openframe://other?v=1',
      uri().replaceFirst('v=1', 'v=2'),
      '${uri()}&code=$code',
      '${uri()}&v=1',
      '${uri()}#fragment',
      uri().replaceFirst('pair?', 'pair/path?'),
      jsonEncode({'version': 2, 'code': code, 'serverUrls': servers}),
      jsonEncode({'version': 1, 'code': code, 'serverUrls': []}),
      'x' * 8193,
    ]) {
      expect(() => PairingPayload.parse(input), throwsFormatException);
    }
  });

  test('rejects URLs with credentials, queries, fragments, missing host or unsafe scheme', () {
    for (final url in [
      'file:///tmp/a',
      'javascript:alert(1)',
      '//example.com',
      'https://',
      'https://user:password@example.com',
      'https://example.com?token=secret',
      'https://example.com#secret',
      'https://example.com\\@evil.test',
      'https://exa mple.com',
    ]) {
      expect(() => PairingPayload.parse(uri(urls: [url])), throwsFormatException);
    }
  });

  test('does not include scanned secrets in decoder exceptions', () {
    try {
      PairingPayload.parse('{"code":"$code"');
      fail('Expected invalid JSON to fail');
    } on FormatException catch (error) {
      expect(error.toString(), isNot(contains(code)));
    }
  });
}
