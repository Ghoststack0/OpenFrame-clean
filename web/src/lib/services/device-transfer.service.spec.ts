import { DeviceTransferAction, getDeviceTargets, sendToDevice, type DeviceTransferDto } from '@immich/sdk';
import { listDeviceTargets, sendAssetsToDevice } from '$lib/services/device-transfer.service';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getDeviceTargets: vi.fn(),
  sendToDevice: vi.fn(),
}));

describe('device transfer service', () => {
  it('lists targets using the authenticated SDK', async () => {
    const targets = [
      { id: 'target', deviceType: 'Chrome', deviceOS: 'Linux', deviceName: 'Chrome', label: 'Chrome on Linux' },
    ];
    vi.mocked(getDeviceTargets).mockResolvedValue(targets);
    await expect(listDeviceTargets()).resolves.toEqual(targets);
  });

  it('sends the selection and propagates offline errors', async () => {
    const dto: DeviceTransferDto = {
      targetSessionId: 'target',
      assetIds: ['asset'],
      action: DeviceTransferAction.Open,
    };
    vi.mocked(sendToDevice).mockRejectedValue(new Error('Target session is offline'));
    await expect(sendAssetsToDevice(dto)).rejects.toThrow('Target session is offline');
    expect(sendToDevice).toHaveBeenCalledWith({ deviceTransferDto: dto });
  });
});
