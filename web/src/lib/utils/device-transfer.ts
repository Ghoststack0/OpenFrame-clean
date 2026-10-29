import { isHttpError } from '@immich/sdk';
import {
  mdiAndroid,
  mdiApple,
  mdiAppleSafari,
  mdiCast,
  mdiGoogleChrome,
  mdiLinux,
  mdiMicrosoftWindows,
  mdiMonitor,
  mdiUbuntu,
} from '@mdi/js';

export const DEVICE_TRANSFER_MAX_ASSETS = 100;

/** Picks an icon for a session using the same OS/browser heuristics as the authorized devices list. */
export const getDeviceIcon = ({ deviceType, deviceOS }: { deviceType: string; deviceOS: string }) => {
  if (deviceOS === 'Android') {
    return mdiAndroid;
  }
  if (deviceOS === 'iOS' || deviceOS === 'macOS') {
    return mdiApple;
  }
  if (deviceOS.includes('Safari')) {
    return mdiAppleSafari;
  }
  if (deviceOS.includes('Windows')) {
    return mdiMicrosoftWindows;
  }
  if (deviceOS === 'Linux') {
    return mdiLinux;
  }
  if (deviceOS === 'Ubuntu') {
    return mdiUbuntu;
  }
  if (
    deviceOS === 'Chrome OS' ||
    deviceType === 'Chrome' ||
    deviceType === 'Chromium' ||
    deviceType === 'Mobile Chrome'
  ) {
    return mdiGoogleChrome;
  }
  if (deviceOS === 'Google Cast') {
    return mdiCast;
  }
  return mdiMonitor;
};

export type DeviceTransferErrorKind = 'unavailable' | 'offline' | 'invalid' | 'unknown';

/** Maps the send-to-device error statuses: 404 target gone, 409 target offline, 400 bad selection or no access. */
export const getDeviceTransferErrorKind = (error: unknown): DeviceTransferErrorKind => {
  if (!isHttpError(error)) {
    return 'unknown';
  }
  switch (error.status) {
    case 404: {
      return 'unavailable';
    }
    case 409: {
      return 'offline';
    }
    case 400: {
      return 'invalid';
    }
    default: {
      return 'unknown';
    }
  }
};
