import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/services/lan_direct_transfer.service.dart';

export 'package:immich_mobile/services/lan_direct_transfer.service.dart'
    show LanProbe, LanProbeResult, LanRoute, LanRouteState;

final lanDirectTransferProvider = StateProvider<LanRouteState>((_) => const LanRouteState());
