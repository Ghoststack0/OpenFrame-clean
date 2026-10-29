import { getDeviceTargets, sendToDevice, type DeviceTransferDto } from '@immich/sdk';

export const listDeviceTargets = () => getDeviceTargets();

export const sendAssetsToDevice = (dto: DeviceTransferDto) => sendToDevice({ deviceTransferDto: dto });
