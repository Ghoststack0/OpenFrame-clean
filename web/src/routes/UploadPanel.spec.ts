import { AssetProcessingStage as Stage, AssetProcessingState as State } from '@immich/sdk';
import { fireEvent, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { addMessages, locale } from 'svelte-i18n';
import { get } from 'svelte/store';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '$i18n/en.json';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { assetProcessingStore } from '$lib/stores/asset-processing';
import { uploadAssetsStore } from '$lib/stores/upload';
import { processingSummary, uploadedAssets } from '$lib/stores/upload-processing';
import { UploadState } from '$lib/types';
import { renderWithTooltips as render } from '$tests/helpers';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import UploadPanel from './UploadPanel.svelte';

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<typeof import('@immich/sdk')>()),
  getAssetProcessingStatus: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/utils/file-uploader', () => ({
  uploadExecutionQueue: { concurrency: 1 },
  fileUploadHandler: vi.fn(),
}));
vi.mock('$lib/utils/wakelock.svelte', () => ({
  acquireWakeLock: vi.fn(),
  releaseWakeLock: vi.fn(),
}));

const complete = State.Complete;
const skipped = State.Skipped;
const failed = State.Failed;

/** Uploads a file the way the uploader does, which starts tracking its processing status. */
const upload = (id: string, name = `${id}.jpg`, type = 'image/jpeg') => {
  uploadAssetsStore.addItem({ id, file: new File(['x'], name, { type }) });
  uploadAssetsStore.updateItem(id, { state: UploadState.DONE, assetId: id });
};

const setStages = (assetId: string, states: Partial<Record<Stage, State>>) => {
  for (const [stage, state] of Object.entries(states)) {
    assetProcessingStore.update({ assetId, stage: stage as Stage, state });
  }
};

/** Everything the server does after the upload, finished */
const finish = (assetId: string) =>
  setStages(assetId, {
    [Stage.Metadata]: complete,
    [Stage.Thumbnails]: complete,
    [Stage.Video]: skipped,
    [Stage.SmartSearch]: complete,
    [Stage.Faces]: complete,
  });

/** The bytes are all sent: the upload rows go away but processing continues */
const clearUploadRows = (...ids: string[]) => {
  for (const id of ids) {
    uploadAssetsStore.removeItem(id);
  }
};

describe('UploadPanel', () => {
  beforeAll(async () => {
    addMessages('en', en);
    await locale.set('en');
  });

  beforeEach(() => {
    uploadAssetsStore.reset();
    assetProcessingStore.reset();
    uploadedAssets.reset();
    authManager.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('stage indicators', () => {
    it('shows a labelled, distinct indicator for every state', async () => {
      upload('a');
      setStages('a', { [Stage.Metadata]: complete, [Stage.SmartSearch]: skipped, [Stage.Faces]: failed });
      render(UploadPanel, {});

      const pipeline = await screen.findByRole('list', { name: 'Processing steps for a.jpg' });
      const items = within(pipeline);
      expect(items.getByTitle('Uploaded: Done')).toBeTruthy();
      expect(items.getByTitle('Reading metadata: Done')).toBeTruthy();
      // thumbnails run next, everything after them waits
      expect(items.getByTitle('Generating previews: In progress')).toBeTruthy();
      expect(items.getByTitle('Smart search: Skipped')).toBeTruthy();
      expect(items.getByTitle('Detecting faces: Failed')).toBeTruthy();
    });

    it('marks stages behind unfinished thumbnails as waiting', async () => {
      upload('a', 'clip.mov', 'video/quicktime');
      render(UploadPanel, {});

      const pipeline = await screen.findByRole('list', { name: 'Processing steps for clip.mov' });
      expect(within(pipeline).getByTitle('Reading metadata: In progress')).toBeTruthy();
      expect(within(pipeline).getByTitle('Generating previews: Waiting')).toBeTruthy();
      expect(within(pipeline).getByTitle('Processing video: Waiting')).toBeTruthy();
    });

    it('exposes each stage state as text for screen readers, not only colour', async () => {
      upload('a');
      setStages('a', { [Stage.Metadata]: failed });
      render(UploadPanel, {});

      const pipeline = await screen.findByRole('list', { name: 'Processing steps for a.jpg' });
      expect(within(pipeline).getByText('Reading metadata: Failed', { selector: '.sr-only' })).toBeTruthy();
    });

    it('hides the video stage for images but shows it for videos', async () => {
      upload('photo', 'photo.jpg', 'image/jpeg');
      upload('movie', 'movie.mp4', 'video/mp4');
      render(UploadPanel, {});

      const photo = await screen.findByRole('list', { name: 'Processing steps for photo.jpg' });
      const movie = screen.getByRole('list', { name: 'Processing steps for movie.mp4' });
      expect(within(photo).queryByTitle(/Processing video/)).toBeNull();
      expect(
        within(photo)
          .getAllByRole('listitem')
          .filter((item) => item.title),
      ).toHaveLength(5);
      expect(within(movie).getByTitle(/Processing video/)).toBeTruthy();
    });
  });

  describe('summary', () => {
    it('counts processed items and failures in a polite live region', async () => {
      for (const id of ['a', 'b', 'c', 'd']) {
        upload(id);
      }
      finish('a');
      finish('b');
      setStages('c', { [Stage.Thumbnails]: failed });
      render(UploadPanel, {});

      const summary = await screen.findByRole('status');
      expect(summary.getAttribute('aria-live')).toBe('polite');
      expect(summary.textContent).toContain('Processing 3 of 4 · 1 failed');
    });

    it('updates as events arrive and treats complete and skipped stages as done', async () => {
      upload('a');
      upload('b');
      render(UploadPanel, {});
      const summary = await screen.findByRole('status');
      expect(summary.textContent).toContain('Processing 0 of 2');

      finish('a');
      expect(await screen.findByText('Processing 1 of 2')).toBeTruthy();
    });

    it('reports completion and closes itself after a moment once nothing failed', async () => {
      vi.useFakeTimers();
      upload('a');
      finish('a');
      render(UploadPanel, {});
      clearUploadRows('a');

      await tick();
      expect(screen.getByRole('status').textContent).toContain('Processing complete');
      await vi.advanceTimersByTimeAsync(3100);
      // the panel then has nothing to show; its fade-out doesn't complete under happy-dom
      expect(get(processingSummary).total).toBe(0);
      expect(get(assetProcessingStore).size).toBe(0);
    });

    it('stays open while something failed', async () => {
      vi.useFakeTimers();
      upload('a');
      setStages('a', { [Stage.Faces]: failed });
      render(UploadPanel, {});
      clearUploadRows('a');

      await tick();
      expect(screen.getByRole('status').textContent).toContain('Processing finished · 1 failed');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(get(processingSummary)).toMatchObject({ total: 1, failed: 1 });
    });
  });

  describe('failures', () => {
    const renderWithFailure = async () => {
      upload('a');
      upload('b');
      setStages('a', { [Stage.Thumbnails]: failed });
      setStages('b', { [Stage.Faces]: failed });
      render(UploadPanel, {});
      return screen.findByText('Processing failed for 2 items');
    };

    it('only tells non-admins how many items failed', async () => {
      authManager.setUser(userAdminFactory.build({ isAdmin: false }));
      authManager.setPreferences(preferencesFactory.build());
      await renderWithFailure();

      expect(screen.queryByRole('link', { name: 'View jobs' })).toBeNull();
    });

    it('also tells logged-out sessions, such as shared links, without a link', async () => {
      await renderWithFailure();

      expect(screen.queryByRole('link', { name: 'View jobs' })).toBeNull();
    });

    it('links admins to the jobs page', async () => {
      authManager.setUser(userAdminFactory.build({ isAdmin: true }));
      authManager.setPreferences(preferencesFactory.build());
      await renderWithFailure();

      expect(screen.getByRole('link', { name: 'View jobs' }).getAttribute('href')).toBe('/admin/queues');
    });

    it('uses the singular for one item', async () => {
      upload('a');
      setStages('a', { [Stage.Thumbnails]: failed });
      render(UploadPanel, {});

      expect(await screen.findByText('Processing failed for 1 item')).toBeTruthy();
    });

    it('dismisses a single failed item', async () => {
      upload('a');
      upload('b');
      setStages('a', { [Stage.Thumbnails]: failed });
      render(UploadPanel, {});

      await fireEvent.click(await screen.findByRole('button', { name: 'Dismiss a.jpg' }));

      expect(screen.queryByRole('list', { name: 'Processing steps for a.jpg' })).toBeNull();
      expect(screen.getByRole('list', { name: 'Processing steps for b.jpg' })).toBeTruthy();
    });
  });

  describe('clear finished', () => {
    it('removes only fully processed items', async () => {
      upload('done');
      upload('busy');
      upload('broken');
      finish('done');
      setStages('broken', { [Stage.Faces]: failed });
      render(UploadPanel, {});

      await fireEvent.click(await screen.findByRole('button', { name: 'Clear finished' }));

      expect(screen.queryByRole('list', { name: 'Processing steps for done.jpg' })).toBeNull();
      expect(screen.getByRole('list', { name: 'Processing steps for busy.jpg' })).toBeTruthy();
      expect(screen.getByRole('list', { name: 'Processing steps for broken.jpg' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Clear finished' })).toBeNull();
    });

    it('lets the user stop following items that are still processing', async () => {
      upload('done');
      upload('busy');
      finish('done');
      render(UploadPanel, {});

      await fireEvent.click(await screen.findByRole('button', { name: 'Hide processing' }));

      expect(screen.queryByRole('list', { name: 'Processing steps for done.jpg' })).toBeNull();
      expect(screen.queryByRole('list', { name: 'Processing steps for busy.jpg' })).toBeNull();
    });

    it('is hidden while nothing has finished', async () => {
      upload('busy');
      render(UploadPanel, {});

      await screen.findByRole('list', { name: 'Processing steps for busy.jpg' });
      expect(screen.queryByRole('button', { name: 'Clear finished' })).toBeNull();
    });

    it('keeps the existing dismiss-errors behaviour for failed uploads', async () => {
      uploadAssetsStore.addItem({ id: 'bad', file: new File(['x'], 'bad.jpg', { type: 'image/jpeg' }) });
      uploadAssetsStore.updateItem('bad', { state: UploadState.ERROR, error: 'nope' });
      render(UploadPanel, {});

      await fireEvent.click(await screen.findByRole('button', { name: 'Dismiss all errors' }));

      // the row's fade-out doesn't complete under happy-dom, so check the store it renders
      expect(get(uploadAssetsStore)).toEqual([]);
    });
  });

  describe('minimised button', () => {
    const minimise = async () => fireEvent.click(await screen.findByRole('button', { name: 'Minimize' }));

    it('shows byte progress while uploading', async () => {
      uploadAssetsStore.addItem({ id: 'a', file: new File(['x'], 'a.jpg', { type: 'image/jpeg' }) });
      render(UploadPanel, {});
      await minimise();

      expect(await screen.findByRole('button', { name: 'Upload Details' })).toBeTruthy();
      expect(screen.queryByTestId('processing-ring')).toBeNull();
    });

    it('keeps showing activity with a separate spinning ring after the bytes are done', async () => {
      upload('a');
      upload('b');
      finish('a');
      render(UploadPanel, {});
      await minimise();
      clearUploadRows('a', 'b');

      expect(await screen.findByTestId('processing-ring')).toBeTruthy();
      // one item left to process
      expect(screen.getByText('1')).toBeTruthy();
    });

    it('stops the processing ring when everything is processed', async () => {
      upload('a');
      render(UploadPanel, {});
      await minimise();
      clearUploadRows('a');
      expect(await screen.findByTestId('processing-ring')).toBeTruthy();

      finish('a');

      expect(await screen.findByRole('button', { name: 'Upload Details' })).toBeTruthy();
      expect(screen.queryByTestId('processing-ring')).toBeNull();
    });

    it('counts processing failures on the error badge', async () => {
      upload('a');
      setStages('a', { [Stage.Faces]: failed });
      render(UploadPanel, {});
      await minimise();
      clearUploadRows('a');

      expect(await screen.findByText('1', { selector: 'button.bg-danger' })).toBeTruthy();
    });
  });
});
