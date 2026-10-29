import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' show ClientException;
import 'package:immich_mobile/utils/pairing_failure.dart';
import 'package:openapi/api.dart';

void main() {
  group('pairingFailureFrom', () {
    test('maps unparseable QR codes to invalidQr', () {
      expect(pairingFailureFrom(const FormatException('Invalid pairing payload')), PairingFailure.invalidQr);
    });

    test('maps HTTP statuses from redemption', () {
      expect(pairingFailureFrom(ApiException(401, 'Invalid pairing code')), PairingFailure.codeInvalid);
      expect(pairingFailureFrom(ApiException(429, 'Too many')), PairingFailure.tooManyAttempts);
      expect(pairingFailureFrom(ApiException(400, 'Validation failed')), PairingFailure.invalidQr);
      expect(pairingFailureFrom(ApiException(503, 'Server is not reachable')), PairingFailure.unreachable);
      expect(pairingFailureFrom(ApiException(403, 'Forbidden')), PairingFailure.unknown);
    });

    test('maps network failures to unreachable, including ones wrapped by the API client', () {
      expect(pairingFailureFrom(const SocketException('no route')), PairingFailure.unreachable);
      expect(pairingFailureFrom(TimeoutException('slow')), PairingFailure.unreachable);
      expect(pairingFailureFrom(const HandshakeException('bad cert')), PairingFailure.unreachable);
      expect(pairingFailureFrom(ClientException('closed')), PairingFailure.unreachable);
      expect(
        pairingFailureFrom(ApiException.withInner(400, 'Socket operation failed', const SocketException('x'), null)),
        PairingFailure.unreachable,
      );
    });

    test('maps an existing session to alreadySignedIn', () {
      expect(pairingFailureFrom(StateError('Sign out before pairing a phone')), PairingFailure.alreadySignedIn);
    });

    test('falls back to unknown without leaking the error text', () {
      expect(pairingFailureFrom(StateError('Unable to save paired session')), PairingFailure.unknown);
      expect(pairingFailureFrom(ArgumentError('Server must be a pairing URL candidate')), PairingFailure.unknown);
      expect(pairingFailureFrom(Exception('boom')), PairingFailure.unknown);
    });
  });
}
