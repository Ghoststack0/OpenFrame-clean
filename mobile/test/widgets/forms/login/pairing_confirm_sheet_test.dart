import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/widgets/forms/login/pairing_confirm_sheet.dart';
import 'package:openapi/api.dart';

import '../../../widget_tester_extensions.dart';

class _Host extends StatelessWidget {
  final List<String> serverUrls;
  final Future<void> Function(String) onConnect;
  final ValueChanged<bool> onResult;

  const _Host({required this.serverUrls, required this.onConnect, required this.onResult});

  @override
  Widget build(BuildContext context) => Center(
    child: ElevatedButton(
      onPressed: () async =>
          onResult(await PairingConfirmSheet.show(context, serverUrls: serverUrls, onConnect: onConnect)),
      child: const Text('open'),
    ),
  );
}

Future<void> _open(
  WidgetTester tester, {
  required List<String> serverUrls,
  required Future<void> Function(String) onConnect,
  ValueChanged<bool>? onResult,
}) async {
  await tester.pumpConsumerWidget(_Host(serverUrls: serverUrls, onConnect: onConnect, onResult: onResult ?? (_) {}));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('shows the server and does not redeem until Connect is tapped', (tester) async {
    final connected = <String>[];
    await _open(tester, serverUrls: ['https://photos.example.com'], onConnect: (url) async => connected.add(url));

    expect(find.text('Sign in to this server?'), findsOneWidget);
    expect(find.text('https://photos.example.com'), findsOneWidget);
    expect(find.text('Server'), findsOneWidget);
    expect(find.byType(RadioListTile<String>), findsNothing);
    expect(connected, isEmpty);
  });

  testWidgets('redeems against the first server by default and closes with true', (tester) async {
    final connected = <String>[];
    bool? result;
    await _open(
      tester,
      serverUrls: ['https://photos.example.com', 'https://other.example.com'],
      onConnect: (url) async => connected.add(url),
      onResult: (value) => result = value,
    );

    expect(find.byType(RadioListTile<String>), findsNWidgets(2));
    await tester.tap(find.text('Connect'));
    await tester.pumpAndSettle();

    expect(connected, ['https://photos.example.com']);
    expect(result, isTrue);
    expect(find.text('Sign in to this server?'), findsNothing);
  });

  testWidgets('only redeems against the server the user picked', (tester) async {
    final connected = <String>[];
    await _open(
      tester,
      serverUrls: ['https://photos.example.com', 'http://192.168.1.9:2283'],
      onConnect: (url) async => connected.add(url),
    );

    expect(
      find.text('This server doesn\'t use HTTPS. Your sign-in may be visible to others on the network.'),
      findsNothing,
    );
    await tester.tap(find.text('http://192.168.1.9:2283'));
    await tester.pumpAndSettle();
    expect(find.textContaining("doesn't use HTTPS"), findsOneWidget);

    await tester.tap(find.text('Connect'));
    await tester.pumpAndSettle();

    expect(connected, ['http://192.168.1.9:2283']);
  });

  testWidgets('cancel closes with false without redeeming', (tester) async {
    var calls = 0;
    bool? result;
    await _open(
      tester,
      serverUrls: ['https://photos.example.com'],
      onConnect: (_) async => calls++,
      onResult: (value) => result = value,
    );

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(calls, 0);
    expect(result, isFalse);
  });

  const failures = {
    '401': 'This code has expired or was already used. Generate a new QR code and try again.',
    '429': 'Too many attempts. Generate a new QR code and try again.',
    '503': "Couldn't reach the server. Check your network connection and try again.",
  };
  for (final entry in failures.entries) {
    testWidgets('shows a friendly message for HTTP ${entry.key} and stays open for another try', (tester) async {
      var calls = 0;
      await _open(
        tester,
        serverUrls: ['https://photos.example.com'],
        onConnect: (_) async {
          calls++;
          throw ApiException(int.parse(entry.key), 'raw server message');
        },
      );

      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      expect(find.text(entry.value), findsOneWidget);
      expect(find.text('raw server message'), findsNothing);
      expect(find.text('Sign in to this server?'), findsOneWidget);

      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();
      expect(calls, 2);
    });
  }

  testWidgets('shows the already signed in message', (tester) async {
    await _open(
      tester,
      serverUrls: ['https://photos.example.com'],
      onConnect: (_) async => throw StateError('Sign out before pairing a phone'),
    );

    await tester.tap(find.text('Connect'));
    await tester.pumpAndSettle();

    expect(find.text("You're already signed in. Sign out first to connect with a QR code."), findsOneWidget);
  });
}
