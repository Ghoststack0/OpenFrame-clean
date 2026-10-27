import { DeviceTransferAction, type DeviceTransferResponseDto, type SessionTargetResponseDto } from '@immich/sdk';
import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { get } from 'svelte/store';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import DeviceTransferNotifications from '$lib/components/DeviceTransferNotifications.svelte';
import { Route } from '$lib/route';
import { listDeviceTargets } from '$lib/services/device-transfer.service';
import { deviceTransferStore } from '$lib/stores/device-transfer.store';
import { downloadArchive } from '$lib/utils/asset-utils';
import { renderWithTooltips } from '$tests/helpers';

const { goto } = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/services/device-transfer.service', () => ({ listDeviceTargets: vi.fn() }));
vi.mock('$lib/utils/asset-utils', () => ({ downloadArchive: vi.fn() }));

const source: SessionTargetResponseDto = {
  id: '11111111-1111-4111-8111-111111111111',
  deviceType: 'Immich_Android',
  deviceOS: 'Android',
  deviceName: 'Immich_Android',
  label: 'Immich_Android on Android (11111111)',
};

const transfer = (overrides: Partial<DeviceTransferResponseDto> = {}): DeviceTransferResponseDto => ({
  id: 'transfer-1',
  sourceSessionId: source.id,
  targetSessionId: '33333333-3333-4333-8333-333333333333',
  assetIds: ['asset-1', 'asset-2', 'asset-3'],
  action: DeviceTransferAction.Open,
  sentAt: '2026-10-28T00:00:00.000Z',
  ...overrides,
});

describe('DeviceTransferNotifications component', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    Element.prototype.animate = getAnimateMock();
    vi.mocked(listDeviceTargets).mockResolvedValue([source]);
    deviceTransferStore.clear();
  });

  it('renders nothing and takes no action while there are no transfers', () => {
    renderWithTooltips(DeviceTransferNotifications, {});

    expect(screen.queryByRole('region', { name: 'Incoming transfers' })).toBeNull();
    expect(goto).not.toHaveBeenCalled();
    expect(downloadArchive).not.toHaveBeenCalled();
  });

  it('announces an incoming open transfer without navigating or downloading', async () => {
    renderWithTooltips(DeviceTransferNotifications, {});
    deviceTransferStore.receive(transfer());

    expect(await screen.findByText(`${source.label} sent you 3 photos`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    expect(goto).not.toHaveBeenCalled();
    expect(downloadArchive).not.toHaveBeenCalled();
  });

  it('falls back to a generic name when the source device cannot be resolved', async () => {
    vi.mocked(listDeviceTargets).mockResolvedValue([]);
    renderWithTooltips(DeviceTransferNotifications, {});
    deviceTransferStore.receive(transfer({ assetIds: ['asset-1'] }));

    expect(await screen.findByText('Another device sent you 1 photo')).toBeTruthy();
  });

  it('opens the first asset only after clicking Open, then dismisses the card', async () => {
    const user = userEvent.setup();
    renderWithTooltips(DeviceTransferNotifications, {});
    deviceTransferStore.receive(transfer());

    await user.click(await screen.findByRole('button', { name: 'Open' }));

    expect(goto).toHaveBeenCalledExactlyOnceWith(Route.viewAsset({ id: 'asset-1' }));
    expect(get(deviceTransferStore)).toEqual([]);
  });

  it('downloads only after clicking Download, then dismisses the card', async () => {
    const user = userEvent.setup();
    renderWithTooltips(DeviceTransferNotifications, {});
    deviceTransferStore.receive(transfer({ action: DeviceTransferAction.Download }));

    expect(downloadArchive).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Download' }));

    expect(downloadArchive).toHaveBeenCalledExactlyOnceWith('openframe-transfer', {
      assetIds: ['asset-1', 'asset-2', 'asset-3'],
    });
    expect(goto).not.toHaveBeenCalled();
    expect(get(deviceTransferStore)).toEqual([]);
  });

  it('dismisses a card without acting on it', async () => {
    const user = userEvent.setup();
    renderWithTooltips(DeviceTransferNotifications, {});
    deviceTransferStore.receive(transfer());

    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));

    expect(get(deviceTransferStore)).toEqual([]);
    expect(goto).not.toHaveBeenCalled();
    expect(downloadArchive).not.toHaveBeenCalled();
  });

  it('dismisses the focused card with Escape', async () => {
    const user = userEvent.setup();
    renderWithTooltips(DeviceTransferNotifications, {});
    deviceTransferStore.receive(transfer());

    const open = await screen.findByRole('button', { name: 'Open' });
    open.focus();
    await user.keyboard('{Escape}');

    expect(get(deviceTransferStore)).toEqual([]);
    expect(goto).not.toHaveBeenCalled();
  });

  it('stacks several transfers and can dismiss them all', async () => {
    const user = userEvent.setup();
    renderWithTooltips(DeviceTransferNotifications, {});
    deviceTransferStore.receive(transfer({ id: 'one' }));
    deviceTransferStore.receive(transfer({ id: 'two', action: DeviceTransferAction.Download }));

    const region = await screen.findByRole('region', { name: 'Incoming transfers' });
    await waitFor(() => expect(within(region).getAllByTestId('device-transfer-card')).toHaveLength(2));

    await user.click(within(region).getByRole('button', { name: 'Dismiss all' }));

    expect(get(deviceTransferStore)).toEqual([]);
    expect(goto).not.toHaveBeenCalled();
    expect(downloadArchive).not.toHaveBeenCalled();
  });
});
