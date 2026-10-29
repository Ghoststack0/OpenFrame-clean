import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/presentation/widgets/device_transfer/send_to_device_sheet.widget.dart';
import 'package:immich_mobile/providers/device_transfer.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/services/device_transfer.service.dart';
import 'package:immich_mobile/services/toast.service.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../../../widget_tester_extensions.dart';

class MockDeviceTransferService extends Mock implements DeviceTransferService {}

class FakeToastService implements ToastService {
  final successes = <String>[];
  final errors = <String>[];

  @override
  FutureOr<void> success(String message, {ToastOption? toast}) {
    successes.add(message);
  }

  @override
  FutureOr<void> error(String message, {ToastOption? toast}) {
    errors.add(message);
  }
}

SessionTargetResponseDto _target(String id, String type, String os) =>
    SessionTargetResponseDto(id: id, deviceType: type, deviceOS: os, deviceName: type, label: '$type on $os ($id)');

void main() {
  late MockDeviceTransferService service;
  late FakeToastService toast;
  final phone = _target('11111111', 'Immich_Android', 'Android');
  final laptop = _target('22222222', 'Firefox', 'Linux');

  setUpAll(() => registerFallbackValue(DeviceTransferAction.open));

  setUp(() {
    service = MockDeviceTransferService();
    toast = FakeToastService();
  });

  Future<void> openSheet(WidgetTester tester, List<String> assetIds) async {
    await tester.pumpConsumerWidget(
      Builder(
        builder: (context) =>
            TextButton(onPressed: () => showSendToDeviceSheet(context, assetIds), child: const Text('launch')),
      ),
      overrides: [
        deviceTransferServiceProvider.overrideWithValue(service),
        toastServiceProvider.overrideWithValue(toast),
      ],
    );
    await tester.tap(find.text('launch'));
    await tester.pump();
  }

  testWidgets('shows a labelled progress indicator while targets load', (tester) async {
    final pending = Completer<List<SessionTargetResponseDto>>();
    when(() => service.listTargets()).thenAnswer((_) => pending.future);
    final semantics = tester.ensureSemantics();

    await openSheet(tester, ['a']);

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.bySemanticsLabel('Loading'), findsWidgets);

    pending.complete([]);
    await tester.pumpAndSettle();
    semantics.dispose();
  });

  testWidgets('shows the empty state when no other device is online', (tester) async {
    when(() => service.listTargets()).thenAnswer((_) async => []);

    await openSheet(tester, ['a']);
    await tester.pumpAndSettle();

    expect(find.text('No other devices are online. Open OpenFrame on your phone or another browser.'), findsOneWidget);
  });

  testWidgets('shows a retry when loading targets fails', (tester) async {
    var calls = 0;
    when(() => service.listTargets()).thenAnswer((_) async {
      calls++;
      if (calls == 1) {
        throw ApiException(500, 'boom');
      }
      return [phone];
    });

    await openSheet(tester, ['a']);
    await tester.pumpAndSettle();
    expect(find.text('Unable to load your devices'), findsOneWidget);

    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(find.text(phone.label), findsOneWidget);
  });

  testWidgets('sends with "open" by default, toasts the device and closes the sheet', (tester) async {
    when(() => service.listTargets()).thenAnswer((_) async => [phone, laptop]);
    when(
      () => service.send(
        targetSessionId: any(named: 'targetSessionId'),
        assetIds: any(named: 'assetIds'),
        action: any(named: 'action'),
      ),
    ).thenAnswer((_) async => throw UnimplementedError());
    when(
      () => service.send(targetSessionId: phone.id, assetIds: ['a', 'b'], action: DeviceTransferAction.open),
    ).thenAnswer(
      (_) async => DeviceTransferResponseDto(
        id: 'transfer',
        sourceSessionId: 'me',
        targetSessionId: phone.id,
        assetIds: ['a', 'b'],
        action: DeviceTransferAction.open,
        sentAt: DateTime(2026),
      ),
    );

    await openSheet(tester, ['a', 'b']);
    await tester.pumpAndSettle();
    expect(find.text('Send 2 items to'), findsOneWidget);

    await tester.tap(find.text(phone.label));
    await tester.pumpAndSettle();

    expect(toast.successes, ['Sent to ${phone.label}']);
    expect(toast.errors, isEmpty);
    expect(find.text('Send to device'), findsNothing);
  });

  testWidgets('sends with "download" when selected', (tester) async {
    when(() => service.listTargets()).thenAnswer((_) async => [laptop]);
    when(
      () => service.send(targetSessionId: laptop.id, assetIds: ['a'], action: DeviceTransferAction.download),
    ).thenAnswer(
      (_) async => DeviceTransferResponseDto(
        id: 'transfer',
        sourceSessionId: 'me',
        targetSessionId: laptop.id,
        assetIds: ['a'],
        action: DeviceTransferAction.download,
        sentAt: DateTime(2026),
      ),
    );

    await openSheet(tester, ['a']);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Download there'));
    await tester.pumpAndSettle();
    await tester.tap(find.text(laptop.label));
    await tester.pumpAndSettle();

    verify(
      () => service.send(targetSessionId: laptop.id, assetIds: ['a'], action: DeviceTransferAction.download),
    ).called(1);
  });

  for (final (status, message) in [
    (404, 'Immich_Android on Android (11111111) is no longer available'),
    (409, 'Immich_Android on Android (11111111) is offline'),
    (400, "These items can't be sent. Check your selection and your access to them."),
    (500, 'Unable to send to device'),
  ]) {
    testWidgets('maps a $status response to an error toast and keeps the sheet open', (tester) async {
      when(() => service.listTargets()).thenAnswer((_) async => [phone]);
      when(
        () => service.send(
          targetSessionId: any(named: 'targetSessionId'),
          assetIds: any(named: 'assetIds'),
          action: any(named: 'action'),
        ),
      ).thenThrow(ApiException(status, ''));

      await openSheet(tester, ['a']);
      await tester.pumpAndSettle();
      await tester.tap(find.text(phone.label));
      await tester.pumpAndSettle();

      expect(toast.errors, [message]);
      expect(toast.successes, isEmpty);
      expect(find.text('Send to device'), findsOneWidget);
    });
  }

  testWidgets('disables sending and explains the limit above 100 items', (tester) async {
    when(() => service.listTargets()).thenAnswer((_) async => [phone]);
    final assetIds = List.generate(101, (index) => 'asset-$index');

    await openSheet(tester, assetIds);
    await tester.pumpAndSettle();

    expect(find.text('You can send up to 100 items at a time. Deselect some items and try again.'), findsOneWidget);
    await tester.tap(find.text(phone.label), warnIfMissed: false);
    await tester.pumpAndSettle();

    verifyNever(
      () => service.send(
        targetSessionId: any(named: 'targetSessionId'),
        assetIds: any(named: 'assetIds'),
        action: any(named: 'action'),
      ),
    );
  });
}
