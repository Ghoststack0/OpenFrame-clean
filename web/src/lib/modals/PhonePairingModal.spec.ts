import { PairingState } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import { queryClient } from '$lib/queries/client';
import { createPhonePairing, waitForPhonePairing } from '$lib/services/phone-pairing';
import PhonePairingModal from './PhonePairingModal.svelte';

vi.mock('$lib/services/phone-pairing', () => ({
  createPhonePairing: vi.fn(),
  waitForPhonePairing: vi.fn(),
}));

const secret = 'A'.repeat(43);
const makePairing = (id: string) => ({
  id,
  code: `${id}.${secret}`,
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  serverUrls: ['https://photos.example.com', 'http://192.168.1.9:2283'],
  payload: `openframe://pair?v=1&code=${id}.${secret}`,
  jsonPayload: '{}',
});

type Status = Awaited<ReturnType<typeof waitForPhonePairing>>;

describe('PhonePairingModal component', () => {
  const onClose = vi.fn();
  let signals: AbortSignal[];
  let resolveStatus: (status: Status) => void;

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    vi.resetAllMocks();
    Element.prototype.animate = getAnimateMock();

    signals = [];
    let counter = 0;
    vi.mocked(createPhonePairing).mockImplementation(() =>
      Promise.resolve(makePairing(`00000000-0000-4000-8000-00000000000${++counter}`)),
    );
    vi.mocked(waitForPhonePairing).mockImplementation(
      (_pairing, signal) =>
        new Promise<Status>((resolve, reject) => {
          signals.push(signal);
          resolveStatus = resolve;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
  });

  afterAll(async () => {
    await waitFor(() => {
      expect(document.body.style.pointerEvents).not.toBe('none');
    });
  });

  const qr = () => screen.queryByAltText('Sign-in QR code for your phone. Scan it with the OpenFrame app.');

  it('shows the QR code, instructions, server URLs and countdown while pending', async () => {
    render(PhonePairingModal, { props: { onClose } });

    expect(await screen.findByAltText(/Sign-in QR code/)).toBeTruthy();
    expect(screen.getByText('Open OpenFrame on your phone → Scan QR code')).toBeTruthy();
    expect(screen.getByText('https://photos.example.com')).toBeTruthy();
    expect(screen.getByText('http://192.168.1.9:2283')).toBeTruthy();
    expect(screen.getByRole('timer').textContent?.trim()).toMatch(/^Expires in [45]:\d{2}$/);
    expect(screen.getByRole('status').textContent).toContain('Waiting for your phone to scan the code…');
    expect(screen.queryByRole('button', { name: 'Generate new code' })).toBeNull();
  });

  it('never exposes the pairing secret in the page text or alt text', async () => {
    render(PhonePairingModal, { props: { onClose } });
    const image = await screen.findByAltText(/Sign-in QR code/);

    expect(image.getAttribute('alt')).not.toContain(secret);
    expect(document.body.textContent).not.toContain(secret);
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
  });

  it('shows success, hides the QR, refreshes devices and closes after redemption', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    render(PhonePairingModal, { props: { onClose } });
    await screen.findByAltText(/Sign-in QR code/);

    resolveStatus(PairingState.Redeemed);

    expect(await screen.findByText('Phone connected')).toBeTruthy();
    expect(qr()).toBeNull();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions'] });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce(), { timeout: 4000 });
  });

  it('hides the QR and offers a new code when the code expires', async () => {
    render(PhonePairingModal, { props: { onClose } });
    await screen.findByAltText(/Sign-in QR code/);

    resolveStatus(PairingState.Expired);

    expect(await screen.findByText('This code has expired')).toBeTruthy();
    expect(qr()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Generate new code' }));

    expect(await screen.findByAltText(/Sign-in QR code/)).toBeTruthy();
    expect(createPhonePairing).toHaveBeenCalledTimes(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('explains a locked code and offers a new code', async () => {
    render(PhonePairingModal, { props: { onClose } });
    await screen.findByAltText(/Sign-in QR code/);

    resolveStatus(PairingState.Locked);

    expect(await screen.findByText('This code is locked')).toBeTruthy();
    expect(screen.getByText(/Too many incorrect attempts/)).toBeTruthy();
    expect(qr()).toBeNull();
    expect(screen.getByRole('button', { name: 'Generate new code' })).toBeTruthy();
  });

  it('shows an error with a retry button when the code cannot be created', async () => {
    vi.mocked(createPhonePairing).mockRejectedValueOnce(new Error('boom'));
    render(PhonePairingModal, { props: { onClose } });

    expect(await screen.findByText("Couldn't create a code")).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Generate new code' }));
    expect(await screen.findByAltText(/Sign-in QR code/)).toBeTruthy();
  });

  it('aborts polling, removes the QR and calls onClose when closed', async () => {
    render(PhonePairingModal, { props: { onClose } });
    await screen.findByAltText(/Sign-in QR code/);
    expect(signals[0].aborted).toBe(false);

    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(signals[0].aborted).toBe(true);
    expect(qr()).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('aborts polling when the component is destroyed', async () => {
    const { unmount } = render(PhonePairingModal, { props: { onClose } });
    await screen.findByAltText(/Sign-in QR code/);

    unmount();

    expect(signals[0].aborted).toBe(true);
  });
});
