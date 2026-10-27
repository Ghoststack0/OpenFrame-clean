import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:immich_mobile/services/lan_direct_transfer.service.dart';

class ProbeClient extends MockClient {
  bool closed = false;

  ProbeClient(super.fn);

  @override
  void close() {
    closed = true;
    super.close();
  }
}

void main() {
  final serverId = 'a' * 64;
  final proof = 'b' * 64;
  const publicUrl = 'https://public.example/api';
  late List<String> candidates;
  late Map<String, Duration> delays;
  late List<ProbeClient> clients;
  late List<Uri> discoveryRequests;
  late List<http.Request> probeRequests;
  late String candidateServerId;
  late String candidateProof;
  late int candidateStatus;
  late LanDirectTransferService service;

  setUp(() {
    candidates = ['https://slow.lan', 'https://fast.lan/photos/api/'];
    delays = {'slow.lan': const Duration(milliseconds: 40)};
    clients = [];
    discoveryRequests = [];
    probeRequests = [];
    candidateServerId = serverId;
    candidateProof = proof;
    candidateStatus = 200;
    service = LanDirectTransferService(
      () => MockClient((request) async {
        discoveryRequests.add(request.url);
        expect(request.followRedirects, isFalse);
        return http.Response(jsonEncode({'serverId': serverId, 'proof': proof, 'urls': candidates}), 200);
      }),
      timeout: const Duration(milliseconds: 100),
      probeClient: () {
        final client = ProbeClient((request) async {
          probeRequests.add(request);
          expect(request.followRedirects, isFalse);
          expect(request.headers, isEmpty);
          await Future<void>.delayed(delays[request.url.host] ?? Duration.zero);
          return http.Response(jsonEncode({'serverId': candidateServerId, 'proof': candidateProof}), candidateStatus);
        });
        clients.add(client);
        return client;
      },
    );
  });

  test('chooses the fastest verified URL, preserves proxy paths and sends a fresh challenge', () async {
    final result = await service.select(publicUrl: publicUrl);
    expect(result.route, LanRoute.lan);
    expect(result.url, 'https://fast.lan/photos/api');
    expect(result.lastProbeResult, LanProbeResult.verified);
    expect(result.probes, hasLength(2));
    final nonce = discoveryRequests.single.queryParameters['nonce'];
    expect(nonce, matches(RegExp(r'^[a-f0-9]{64}$')));
    expect(probeRequests.every((request) => request.url.queryParameters['nonce'] == nonce), isTrue);
    expect(clients.every((client) => client.closed), isTrue);
    await service.select(publicUrl: publicUrl);
    expect(discoveryRequests.last.queryParameters['nonce'], isNot(nonce));
  });

  test('rejects a different instance', () async {
    candidateServerId = 'c' * 64;
    final result = await service.select(publicUrl: publicUrl);
    expect(result.route, LanRoute.public);
    expect(result.url, publicUrl);
    expect(result.lastProbeResult, LanProbeResult.identityMismatch);
  });

  test('rejects a copied server ID with an invalid challenge proof', () async {
    candidateProof = 'c' * 64;
    expect((await service.select(publicUrl: publicUrl)).lastProbeResult, LanProbeResult.identityMismatch);
  });

  test('refuses HTTP before probing unless the user explicitly allows it', () async {
    candidates = ['http://192.168.1.2:2283'];
    final refused = await service.select(publicUrl: publicUrl);
    expect(refused.route, LanRoute.public);
    expect(refused.lastProbeResult, LanProbeResult.insecureHttpRefused);
    expect(probeRequests, isEmpty);
    final allowed = await service.select(publicUrl: publicUrl, allowInsecureHttp: true);
    expect(allowed.url, 'http://192.168.1.2:2283/api');
    expect(allowed.route, LanRoute.lan);
  });

  test('requires consent before trusting discovery over public HTTP', () async {
    final result = await service.select(publicUrl: 'http://public.example');
    expect(result.lastProbeResult, LanProbeResult.insecureHttpRefused);
    expect(discoveryRequests, isEmpty);
  });

  test('preserves credentials in the trusted saved login URL without copying them to probes', () async {
    final result = await service.select(publicUrl: 'https://user:password@public.example');
    expect(result.route, LanRoute.lan);
    expect(discoveryRequests.single.userInfo, 'user:password');
    expect(probeRequests.every((request) => request.url.userInfo.isEmpty), isTrue);
  });

  test('falls back after bounded timeouts and closes probe clients', () async {
    delays = {'slow.lan': const Duration(seconds: 1), 'fast.lan': const Duration(seconds: 1)};
    final result = await service.select(publicUrl: publicUrl);
    expect(result.route, LanRoute.public);
    expect(result.lastProbeResult, LanProbeResult.unreachable);
    expect(clients.every((client) => client.closed), isTrue);
  });

  test('rejects redirects instead of following them', () async {
    candidateStatus = 302;
    final result = await service.select(publicUrl: publicUrl);
    expect(result.route, LanRoute.public);
    expect(result.lastProbeResult, LanProbeResult.unreachable);
  });

  test('handles empty candidates', () async {
    candidates = [];
    final result = await service.select(publicUrl: publicUrl);
    expect(result.lastProbeResult, LanProbeResult.noCandidates);
    expect(probeRequests, isEmpty);
  });

  test('rejects credentials, query parameters and unsupported schemes', () async {
    candidates = ['https://user:secret@host', 'https://host?token=secret', 'file:///tmp/server'];
    final result = await service.select(publicUrl: publicUrl);
    expect(result.route, LanRoute.public);
    expect(probeRequests, isEmpty);
  });

  test('deduplicates and bounds the candidate list', () async {
    candidates = ['https://fast.lan', 'https://fast.lan', ...List.generate(20, (i) => 'https://host$i.lan')];
    await service.select(publicUrl: publicUrl);
    expect(probeRequests, hasLength(16));
  });

  test('falls back on unsupported servers, outages, and malformed discovery', () async {
    for (final status in [404, 503, 200]) {
      final failing = LanDirectTransferService(() => MockClient((_) async => http.Response('{}', status)));
      final result = await failing.select(publicUrl: publicUrl);
      expect(result.route, LanRoute.public);
      expect(result.url, publicUrl);
      expect(result.lastProbeResult, LanProbeResult.discoveryFailed);
    }
  });
}
