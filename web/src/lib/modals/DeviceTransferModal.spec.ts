import { DeviceTransferAction, type SessionTargetResponseDto } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import { listDeviceTargets, sendAssetsToDevice } from '$lib/services/device-transfer.service';
import DeviceTransferModal from './DeviceTransferModal.svelte';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  isHttpError: (error: unknown) => typeof (error as { status?: unknown })?.status === 'number',
}));
vi.mock('$lib/services/device-transfer.service', () => ({
  listDeviceTargets: vi.fn(),
  sendAssetsToDevice: vi.fn(),
}));

const phone: SessionTargetResponseDto = {
  id: '11111111-1111-4111-8111-111111111111',
  deviceType: 'Immich_Android',
  deviceOS: 'Android',
  deviceName: 'Immich_Android',
  label: 'Immich_Android on Android (11111111)',
};
const laptop: SessionTargetResponseDto = {
  id: '22222222-2222-4222-8222-222222222222',
  deviceType: 'Firefox',
  deviceOS: 'Linux',
  deviceName: 'Firefox',
  label: 'Firefox on Linux (22222222)',
};

const httpError = (status: number) => Object.assign(new Error(`Error: ${status}`), { status });

describe('DeviceTransferModal component', () => {
  const onClose = vi.fn();

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(toastManager, 'primary').mockImplementation(() => 0 as never);
    vi.spyOn(toastManager, 'danger').mockImplementation(() => 0 as never);
    Element.prototype.animate = getAnimateMock();
  });

  afterAll(async () => {
    await waitFor(() => {
      expect(document.body.style.pointerEvents).not.toBe('none');
    });
  });

  it('shows a loading state while targets are fetched', async () => {
    vi.mocked(listDeviceTargets).mockReturnValue(new Promise(() => {}));
    render(DeviceTransferModal, { props: { onClose, assetIds: ['a'] } });

    expect(await screen.findByRole('status', { name: 'Loading' })).toBeTruthy();
  });

  it('shows the empty state when no other devices are online', async () => {
    vi.mocked(listDeviceTargets).mockResolvedValue([]);
    render(DeviceTransferModal, { props: { onClose, assetIds: ['a'] } });

    expect(
      await screen.findByText('No other devices are online. Open OpenFrame on your phone or another browser.'),
    ).toBeTruthy();
  });

  it('shows an error with retry when targets cannot be loaded', async () => {
    vi.mocked(listDeviceTargets).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([phone]);
    const user = userEvent.setup();
    render(DeviceTransferModal, { props: { onClose, assetIds: ['a'] } });

    expect(await screen.findByText('Unable to load your devices')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: phone.label })).toBeTruthy();
  });

  it('lists targets and sends with "open" by default, then toasts the device name', async () => {
    vi.mocked(listDeviceTargets).mockResolvedValue([phone, laptop]);
    vi.mocked(sendAssetsToDevice).mockResolvedValue({} as never);
    const user = userEvent.setup();
    render(DeviceTransferModal, { props: { onClose, assetIds: ['a', 'b'] } });

    expect((await screen.findByRole('radio', { name: 'Open there' })) as HTMLInputElement).toHaveProperty(
      'checked',
      true,
    );
    await user.click(await screen.findByRole('button', { name: phone.label }));

    expect(sendAssetsToDevice).toHaveBeenCalledWith({
      targetSessionId: phone.id,
      assetIds: ['a', 'b'],
      action: DeviceTransferAction.Open,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toastManager.primary).toHaveBeenCalledWith(`Sent to ${phone.label}`);
  });

  it('sends with "download" when selected', async () => {
    vi.mocked(listDeviceTargets).mockResolvedValue([laptop]);
    vi.mocked(sendAssetsToDevice).mockResolvedValue({} as never);
    const user = userEvent.setup();
    render(DeviceTransferModal, { props: { onClose, assetIds: ['a'] } });

    await user.click(await screen.findByRole('radio', { name: 'Download there' }));
    await user.click(await screen.findByRole('button', { name: laptop.label }));

    expect(sendAssetsToDevice).toHaveBeenCalledWith({
      targetSessionId: laptop.id,
      assetIds: ['a'],
      action: DeviceTransferAction.Download,
    });
  });

  it.each([
    [404, `${phone.label} is no longer available`],
    [409, `${phone.label} is offline`],
    [400, "These items can't be sent. Check your selection and your access to them."],
    [500, 'Unable to send to device'],
  ])('maps a %i response to an error toast and keeps the modal open', async (status, message) => {
    vi.mocked(listDeviceTargets).mockResolvedValue([phone]);
    vi.mocked(sendAssetsToDevice).mockRejectedValue(httpError(status));
    const user = userEvent.setup();
    render(DeviceTransferModal, { props: { onClose, assetIds: ['a'] } });

    await user.click(await screen.findByRole('button', { name: phone.label }));

    await waitFor(() => expect(toastManager.danger).toHaveBeenCalledWith(message));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('refreshes the target list after the device went offline', async () => {
    vi.mocked(listDeviceTargets).mockResolvedValueOnce([phone]).mockResolvedValueOnce([]);
    vi.mocked(sendAssetsToDevice).mockRejectedValue(httpError(409));
    const user = userEvent.setup();
    render(DeviceTransferModal, { props: { onClose, assetIds: ['a'] } });

    await user.click(await screen.findByRole('button', { name: phone.label }));

    expect(
      await screen.findByText('No other devices are online. Open OpenFrame on your phone or another browser.'),
    ).toBeTruthy();
  });

  it('disables sending and explains the limit for more than 100 items', async () => {
    vi.mocked(listDeviceTargets).mockResolvedValue([phone]);
    const assetIds = Array.from({ length: 101 }, (_, index) => `asset-${index}`);
    render(DeviceTransferModal, { props: { onClose, assetIds } });

    const button = (await screen.findByRole('button', { name: phone.label })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText('You can send up to 100 items at a time. Deselect some items and try again.')).toBeTruthy();
    expect(sendAssetsToDevice).not.toHaveBeenCalled();
  });
});
