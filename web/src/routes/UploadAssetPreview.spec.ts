import { render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { UploadState, type UploadAsset } from '$lib/types';
import UploadAssetPreview from './UploadAssetPreview.svelte';

const MiB = 1024 * 1024;
const RESUME_HINT = 'Progress is kept on the server for 24 hours. Retry to resume from where it stopped.';

const uploadAsset = (overrides: Partial<UploadAsset> = {}): UploadAsset => ({
  id: 'large.mp4',
  file: new File(['content'], 'large.mp4'),
  state: UploadState.STARTED,
  progress: 42,
  speed: 0,
  eta: 5,
  message: 'Uploading…',
  phase: { kind: 'chunks' },
  resumable: true,
  ...overrides,
});

describe('UploadAssetPreview', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  it('labels chunked uploads and keeps the percent', () => {
    render(UploadAssetPreview, { props: { uploadAsset: uploadAsset() } });

    expect(screen.getByText('Uploading in chunks')).toBeTruthy();
    expect(screen.getByText(/42%/)).toBeTruthy();
  });

  it('says where an interrupted upload resumes from', () => {
    render(UploadAssetPreview, { props: { uploadAsset: uploadAsset({ phase: { kind: 'resumed', from: 50 * MiB } }) } });

    expect(screen.getByText(/^Resuming from 50/)).toBeTruthy();
  });

  it('shows the retry attempt while reconnecting, without a stale percent', () => {
    render(UploadAssetPreview, { props: { uploadAsset: uploadAsset({ phase: { kind: 'retrying', attempt: 2 } }) } });

    expect(screen.getByText('Reconnecting… (retry 2)')).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('shows verifying while the server finalizes the upload', () => {
    render(UploadAssetPreview, { props: { uploadAsset: uploadAsset({ phase: { kind: 'verifying' } }) } });

    expect(screen.getByText('Verifying…')).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('announces phase labels politely', () => {
    render(UploadAssetPreview, { props: { uploadAsset: uploadAsset({ phase: { kind: 'verifying' } }) } });

    expect(screen.getByText('Verifying…').getAttribute('aria-live')).toBe('polite');
  });

  it('keeps the plain message for uploads that are not chunked', () => {
    render(UploadAssetPreview, { props: { uploadAsset: uploadAsset({ phase: undefined, resumable: undefined }) } });

    expect(screen.getByText('Uploading…')).toBeTruthy();
    expect(screen.queryByText('Uploading in chunks')).toBeNull();
  });

  it('explains that a failed resumable upload can be retried', () => {
    render(UploadAssetPreview, {
      props: { uploadAsset: uploadAsset({ state: UploadState.ERROR, error: 'Network down' }) },
    });

    expect(screen.getByText('Network down')).toBeTruthy();
    expect(screen.getByText(RESUME_HINT)).toBeTruthy();
  });

  it('does not promise resumption for failed uploads that keep no session', () => {
    render(UploadAssetPreview, {
      props: { uploadAsset: uploadAsset({ state: UploadState.ERROR, error: 'Network down', resumable: false }) },
    });

    expect(screen.getByText('Network down')).toBeTruthy();
    expect(screen.queryByText(RESUME_HINT)).toBeNull();
  });
});
