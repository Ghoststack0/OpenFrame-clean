import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/widgets/forms/login/qr_scan_views.dart';

import '../../../widget_tester_extensions.dart';

void main() {
  testWidgets('permission denied explains the problem and links to settings', (tester) async {
    var openedSettings = 0;
    var retried = 0;
    await tester.pumpConsumerWidget(
      QrScanErrorView(isPermissionDenied: true, onOpenSettings: () => openedSettings++, onRetry: () => retried++),
    );

    expect(find.text('Camera access needed'), findsOneWidget);
    await tester.tap(find.text('Open settings'));
    await tester.tap(find.text('Retry'));

    expect(openedSettings, 1);
    expect(retried, 1);
  });

  testWidgets('other camera errors only offer a retry', (tester) async {
    await tester.pumpConsumerWidget(QrScanErrorView(isPermissionDenied: false, onOpenSettings: () {}, onRetry: () {}));

    expect(find.text('Open settings'), findsNothing);
    expect(find.text('Retry'), findsOneWidget);
  });

  testWidgets('the overlay shows the hint and only shows the invalid message when asked', (tester) async {
    await tester.pumpConsumerWidget(const QrScanOverlay(showInvalid: false));
    expect(find.textContaining('Connect phone'), findsOneWidget);
    expect(find.text("This isn't an OpenFrame sign-in QR code."), findsNothing);

    await tester.pumpConsumerWidget(const QrScanOverlay(showInvalid: true));
    expect(find.text("This isn't an OpenFrame sign-in QR code."), findsOneWidget);
  });
}
