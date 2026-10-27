import { screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { uploadAssetsStore } from '$lib/stores/upload';
import { UploadState } from '$lib/types';
import { renderWithTooltips } from '$tests/helpers';
import UploadPanel from './UploadPanel.svelte';

const file = (name: string) => new File(['content'], name);

describe('UploadPanel', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    uploadAssetsStore.reset();
    uploadAssetsStore.setConcurrency(2);
  });

  it('shows how many files upload at a time while uploads are active', () => {
    uploadAssetsStore.setConcurrency(4);
    for (const name of ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']) {
      uploadAssetsStore.addItem({ id: name, file: file(name) });
    }

    renderWithTooltips(UploadPanel, {});

    expect(screen.getByText('Uploading 4 at a time')).toBeTruthy();
  });

  it('never claims more parallel uploads than files left to upload', () => {
    uploadAssetsStore.setConcurrency(4);
    uploadAssetsStore.addItem({ id: 'a.jpg', file: file('a.jpg') });
    uploadAssetsStore.addItem({ id: 'b.jpg', file: file('b.jpg') });
    uploadAssetsStore.markStarted('b.jpg');
    uploadAssetsStore.updateItem('a.jpg', { state: UploadState.DONE });

    renderWithTooltips(UploadPanel, {});

    expect(screen.getByText('Uploading 1 at a time')).toBeTruthy();
  });

  it('hides the parallelism line once nothing is left to upload', () => {
    uploadAssetsStore.addItem({ id: 'a.jpg', file: file('a.jpg') });
    uploadAssetsStore.updateItem('a.jpg', { state: UploadState.DONE });

    renderWithTooltips(UploadPanel, {});

    expect(screen.queryByText(/at a time/)).toBeNull();
  });
});
