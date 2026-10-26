import { logoManager } from '@immich/ui';
import icon from '$lib/assets/openframe/openframe-icon.svg';
import inlineDark from '$lib/assets/openframe/openframe-inline-dark.svg';
import inlineLight from '$lib/assets/openframe/openframe-inline-light.svg';
import stackedDark from '$lib/assets/openframe/openframe-stacked-dark.svg';
import stackedLight from '$lib/assets/openframe/openframe-stacked-light.svg';

// OpenFrame is a fork of Immich. Only user-facing branding changes here: API names, storage keys,
// package names and the `immich` identifiers that clients depend on stay as they are upstream.
export const APP_NAME = 'OpenFrame';

export const openFrameLogos = {
  stacked: { light: stackedLight, dark: stackedDark },
  unstacked: { light: inlineLight, dark: inlineDark },
  // The FUTO lockup is upstream's; OpenFrame has no equivalent, so it reuses the stacked mark.
  stacked_futo: { light: stackedLight, dark: stackedDark },
  icon,
};

/** Swaps the logos rendered by every `<Logo>` from `@immich/ui` for the OpenFrame marks. */
export const applyBranding = () => logoManager.setLogo(openFrameLogos);
