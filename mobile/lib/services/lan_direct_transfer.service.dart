import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;
import 'package:openapi/api.dart';

enum LanRoute { lan, public }

enum LanProbeResult {
  idle,
  verified,
  noCandidates,
  unreachable,
  identityMismatch,
  insecureHttpRefused,
  discoveryFailed,
  disabled,
  manualOverride,
}

class LanProbe {
  final String url;
  final LanProbeResult result;
  final Duration? latency;

  const LanProbe(this.url, this.result, [this.latency]);
}

class LanRouteState {
  final LanRoute route;
  final String? url;
  final LanProbeResult lastProbeResult;
  final List<LanProbe> probes;

  const LanRouteState({
    this.route = LanRoute.public,
    this.url,
    this.lastProbeResult = LanProbeResult.idle,
    this.probes = const [],
  });
}

/// Discovery uses the authenticated public connection. Probes use fresh clients
/// without cookies, custom headers, client certificates, or redirect following.
class LanDirectTransferService {
  final http.Client Function() _discoveryClient;
  final http.Client Function() _probeClient;
  final Duration timeout;

  LanDirectTransferService(
    this._discoveryClient, {
    http.Client Function()? probeClient,
    this.timeout = const Duration(seconds: 2),
  }) : _probeClient = probeClient ?? http.Client.new;

  static String apiUrl(String value) {
    final uri = Uri.parse(value);
    if (!['http', 'https'].contains(uri.scheme) || uri.host.isEmpty) {
      throw const FormatException('Invalid server base URL');
    }
    final path = uri.path.replaceFirst(RegExp(r'/+$'), '');
    return uri.replace(path: path.endsWith('/api') ? path : '$path/api').toString();
  }

  Future<LanRouteState> select({required String publicUrl, bool allowInsecureHttp = false}) async {
    final fallback = apiUrl(publicUrl);
    try {
      // A public HTTP response cannot establish a trusted identity on a hostile LAN.
      if (Uri.parse(fallback).scheme != 'https' && !allowInsecureHttp) {
        return LanRouteState(url: fallback, lastProbeResult: LanProbeResult.insecureHttpRefused);
      }
      final random = Random.secure();
      final nonce = List.generate(32, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
      final uri = Uri.parse('$fallback/server/lan-candidates').replace(queryParameters: {'nonce': nonce});
      final response = await _discoveryClient()
          .send(http.Request('GET', uri)..followRedirects = false)
          .then(http.Response.fromStream)
          .timeout(timeout);
      if (response.statusCode != 200) {
        return LanRouteState(url: fallback, lastProbeResult: LanProbeResult.discoveryFailed);
      }
      final candidates = ServerLanCandidatesResponseDto.fromJson(jsonDecode(response.body));
      if (candidates == null ||
          !RegExp(r'^[a-f0-9]{64}$').hasMatch(candidates.serverId) ||
          !RegExp(r'^[a-f0-9]{64}$').hasMatch(candidates.proof)) {
        return LanRouteState(url: fallback, lastProbeResult: LanProbeResult.discoveryFailed);
      }
      final probes = await Future.wait(
        candidates.urls.toSet().take(16).map((url) => _probe(url, nonce, candidates, allowInsecureHttp)),
      );
      final verified = probes.where((probe) => probe.result == LanProbeResult.verified).toList()
        ..sort((a, b) => a.latency!.compareTo(b.latency!));
      if (verified.isNotEmpty) {
        return LanRouteState(
          route: LanRoute.lan,
          url: verified.first.url,
          lastProbeResult: LanProbeResult.verified,
          probes: List.unmodifiable(probes),
        );
      }
      final result = probes.isEmpty
          ? LanProbeResult.noCandidates
          : probes.any((probe) => probe.result == LanProbeResult.insecureHttpRefused)
          ? LanProbeResult.insecureHttpRefused
          : probes.any((probe) => probe.result == LanProbeResult.identityMismatch)
          ? LanProbeResult.identityMismatch
          : LanProbeResult.unreachable;
      return LanRouteState(url: fallback, lastProbeResult: result, probes: List.unmodifiable(probes));
    } catch (_) {
      // Includes old servers without discovery support and public URL outages.
      return LanRouteState(url: fallback, lastProbeResult: LanProbeResult.discoveryFailed);
    }
  }

  Future<LanProbe> _probe(
    String value,
    String nonce,
    ServerLanCandidatesResponseDto expected,
    bool allowInsecureHttp,
  ) async {
    http.Client? client;
    try {
      final candidate = Uri.parse(value);
      if (candidate.userInfo.isNotEmpty || candidate.hasQuery || candidate.hasFragment) {
        throw const FormatException('Invalid LAN base URL');
      }
      final url = apiUrl(value);
      if (Uri.parse(url).scheme == 'http' && !allowInsecureHttp) {
        return LanProbe(url, LanProbeResult.insecureHttpRefused);
      }
      client = _probeClient();
      final watch = Stopwatch()..start();
      final uri = Uri.parse('$url/server/identity').replace(queryParameters: {'nonce': nonce});
      final response = await client
          .send(http.Request('GET', uri)..followRedirects = false)
          .then(http.Response.fromStream)
          .timeout(timeout);
      if (response.statusCode != 200) {
        return LanProbe(url, LanProbeResult.unreachable);
      }
      final identity = ServerIdentityResponseDto.fromJson(jsonDecode(response.body));
      if (identity?.serverId != expected.serverId || identity?.proof != expected.proof) {
        return LanProbe(url, LanProbeResult.identityMismatch);
      }
      return LanProbe(url, LanProbeResult.verified, watch.elapsed);
    } catch (_) {
      return LanProbe(value, LanProbeResult.unreachable);
    } finally {
      client?.close();
    }
  }
}
