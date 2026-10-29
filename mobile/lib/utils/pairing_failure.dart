import 'dart:async';
import 'dart:io';

import 'package:http/http.dart' show ClientException;
import 'package:immich_mobile/generated/translations.g.dart';
// ignore: import_rule_openapi
import 'package:openapi/api.dart';

enum PairingFailure { invalidQr, codeInvalid, tooManyAttempts, unreachable, alreadySignedIn, unknown }

/// Maps an error from scanning or redeeming a pairing code to a user-facing category.
///
/// Never inspects or returns the error text: it can contain the scanned payload or bearer code.
PairingFailure pairingFailureFrom(Object error) {
  if (error is FormatException) {
    return PairingFailure.invalidQr;
  }
  if (error is ApiException) {
    if (_isNetworkError(error.innerException)) {
      return PairingFailure.unreachable;
    }
    return switch (error.code) {
      400 => PairingFailure.invalidQr,
      401 => PairingFailure.codeInvalid,
      429 => PairingFailure.tooManyAttempts,
      502 || 503 || 504 => PairingFailure.unreachable,
      _ => PairingFailure.unknown,
    };
  }
  if (_isNetworkError(error)) {
    return PairingFailure.unreachable;
  }
  // AuthNotifier.pairPhone throws a StateError when a session already exists.
  if (error is StateError && error.message.startsWith('Sign out')) {
    return PairingFailure.alreadySignedIn;
  }
  return PairingFailure.unknown;
}

bool _isNetworkError(Object? error) =>
    error is SocketException ||
    error is TlsException ||
    error is HttpException ||
    error is TimeoutException ||
    error is ClientException;

extension PairingFailureMessage on PairingFailure {
  String message(Translations t) => switch (this) {
    PairingFailure.invalidQr => t.qr_login_error_invalid_qr,
    PairingFailure.codeInvalid => t.qr_login_error_code_invalid,
    PairingFailure.tooManyAttempts => t.qr_login_error_too_many_attempts,
    PairingFailure.unreachable => t.qr_login_error_unreachable,
    PairingFailure.alreadySignedIn => t.qr_login_error_already_signed_in,
    PairingFailure.unknown => t.qr_login_error_unknown,
  };
}
