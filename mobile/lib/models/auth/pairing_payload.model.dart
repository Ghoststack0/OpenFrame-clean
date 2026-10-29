import 'dart:convert';

/// A short-lived bearer credential. Do not log or persist the payload.
class PairingPayload {
  final List<String> serverUrls;
  final String code;

  const PairingPayload._(this.serverUrls, this.code);

  factory PairingPayload.parse(String input) {
    try {
      return _parse(input);
    } on FormatException {
      // URI and JSON decoder exceptions can contain the bearer credential.
      throw const FormatException('Invalid pairing payload');
    }
  }

  static PairingPayload _parse(String input) {
    if (input.length > 8192) {
      throw const FormatException('Pairing payload is too large');
    }
    final text = input.trim();
    Object? code;
    Object? servers;
    if (text.startsWith('{')) {
      final json = jsonDecode(text);
      if (json is! Map<String, dynamic> || json['version'] != 1) {
        throw const FormatException('Unsupported pairing payload');
      }
      code = json['code'];
      servers = json['serverUrls'];
    } else {
      final uri = Uri.parse(text);
      final query = uri.queryParametersAll;
      if (uri.scheme != 'openframe' ||
          uri.host != 'pair' ||
          uri.path.isNotEmpty ||
          uri.userInfo.isNotEmpty ||
          uri.hasPort ||
          uri.hasFragment ||
          query['v']?.length != 1 ||
          query['v']?.single != '1' ||
          query['code']?.length != 1) {
        throw const FormatException('Unsupported pairing payload');
      }
      code = query['code']?.single;
      servers = query['server'];
    }
    if (code is! String ||
        !RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$').hasMatch(code) ||
        servers is! List ||
        servers.isEmpty ||
        servers.length > 8) {
      throw const FormatException('Invalid pairing payload');
    }
    final urls = <String>[];
    for (final server in servers) {
      if (server is! String) {
        throw const FormatException('Invalid pairing server URL');
      }
      final url = Uri.tryParse(server);
      if (url == null ||
          (url.scheme != 'http' && url.scheme != 'https') ||
          url.host.isEmpty ||
          url.userInfo.isNotEmpty ||
          url.hasQuery ||
          url.hasFragment ||
          server.contains(RegExp(r'[\s\\]'))) {
        throw const FormatException('Invalid pairing server URL');
      }
      urls.add(server.replaceFirst(RegExp(r'/+$'), ''));
    }
    return PairingPayload._(List.unmodifiable(urls.toSet()), code);
  }
}
