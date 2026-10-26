import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

class ImmichLogo extends StatelessWidget {
  final double size;

  const ImmichLogo({super.key, this.size = 100});

  @override
  Widget build(BuildContext context) {
    return SvgPicture.asset('assets/openframe-icon.svg', width: size, height: size, semanticsLabel: 'OpenFrame');
  }
}
