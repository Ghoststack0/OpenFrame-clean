<script lang="ts">
  import { locale } from '$lib/stores/preferences.store';
  import { uploadAssetsStore } from '$lib/stores/upload';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { setUploadConcurrency, uploadExecutionQueue } from '$lib/utils/file-uploader';
  import { acquireWakeLock, releaseWakeLock } from '$lib/utils/wakelock.svelte';
  import { Icon, IconButton, toastManager } from '@immich/ui';
  import { mdiCancel, mdiCloudUploadOutline, mdiCog, mdiWindowMinimize } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { quartInOut } from 'svelte/easing';
  import { fade, scale } from 'svelte/transition';
  import UploadAssetPreview from './UploadAssetPreview.svelte';

  let showDetail = $state(false);
  let showOptions = $state(false);
  let concurrency = $state(uploadExecutionQueue.concurrency);

  let { stats, progress, isDismissible, isUploading, remainingUploads, concurrency: parallelism } = uploadAssetsStore;

  // Circumference of the progress ring drawn around the minimized button (r = 30)
  const ringLength = 2 * Math.PI * 30;

  let hasRemaining = $derived($remainingUploads > 0);

  $effect(() => {
    if ($isUploading) {
      showDetail = true;
    }
  });

  $effect(() => {
    if (hasRemaining) {
      void acquireWakeLock();
    } else {
      void releaseWakeLock();
    }
  });
</script>

{#if $isUploading}
  <div
    in:fade={{ duration: 250 }}
    out:fade={{ duration: 250 }}
    onoutroend={() => {
      if ($stats.errors > 0) {
        toastManager.danger($t('upload_errors', { values: { count: $stats.errors } }));
      } else if ($stats.success > 0) {
        toastManager.primary($t('upload_success'));
      }
      if ($stats.duplicates > 0) {
        toastManager.warning($t('upload_skipped_duplicates', { values: { count: $stats.duplicates } }));
      }
      uploadAssetsStore.reset();
    }}
    class="fixed inset-e-16 bottom-6 z-60"
  >
    {#if showDetail}
      <div
        in:scale={{ duration: 250, easing: quartInOut }}
        class="w-81 rounded-xl border border-gray-200 bg-subtle p-4 text-sm shadow-xs dark:border-subtle"
      >
        <div class="place-item-center mb-4 flex justify-between">
          <div class="flex flex-col gap-1">
            <p class="text-xm immich-form-label">
              {$t('upload_progress', {
                values: {
                  remaining: $remainingUploads,
                  processed: $stats.total - $remainingUploads,
                  total: $stats.total,
                },
              })}
            </p>
            <p class="text-xs immich-form-label">
              {$t('upload_status_uploaded')}
              <span class="text-success">{$stats.success.toLocaleString($locale)}</span>
              -
              {$t('upload_status_errors')}
              <span class="text-danger">{$stats.errors.toLocaleString($locale)}</span>
              -
              {$t('upload_status_duplicates')}
              <span class="text-warning">{$stats.duplicates.toLocaleString($locale)}</span>
            </p>
          </div>
          <div class="flex flex-col items-end">
            <div class="flex flex-row">
              <IconButton
                variant="ghost"
                shape="round"
                color="secondary"
                icon={mdiCog}
                size="small"
                onclick={() => (showOptions = !showOptions)}
                aria-label={$t('toggle_settings')}
              />
              <IconButton
                variant="ghost"
                shape="round"
                color="secondary"
                aria-label={$t('minimize')}
                icon={mdiWindowMinimize}
                size="small"
                onclick={() => (showDetail = false)}
              />
            </div>
            {#if $isDismissible}
              <IconButton
                variant="ghost"
                shape="round"
                color="secondary"
                aria-label={$t('dismiss_all_errors')}
                icon={mdiCancel}
                size="small"
                onclick={() => uploadAssetsStore.dismissErrors()}
              />
            {/if}
          </div>
        </div>
        <div class="mb-4 flex flex-col gap-1.5">
          <div
            role="progressbar"
            aria-label={$t('uploading')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={$progress.percent}
            class="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
          >
            <div
              class="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
              style:width="{$progress.percent}%"
            ></div>
          </div>
          <p class="flex justify-between gap-2 text-xs immich-form-label tabular-nums">
            <span>
              {$progress.percent}% · {getByteUnitString($progress.loaded, $locale)} / {getByteUnitString(
                $progress.total,
                $locale,
              )}
            </span>
            {#if hasRemaining && $progress.speed > 0}
              <span>{getByteUnitString($progress.speed, $locale)}/s</span>
            {/if}
          </p>
          {#if hasRemaining}
            <p class="text-xs immich-form-label">
              {$t('upload_parallelism', { values: { count: Math.min($parallelism, $remainingUploads) } })}
            </p>
          {/if}
        </div>
        {#if showOptions}
          <div class="mb-4 max-h-100 immich-scrollbar overflow-y-auto rounded-lg">
            <div class="flex h-6.5 place-items-center gap-1">
              <label class="immich-form-label" for="upload-concurrency">{$t('upload_concurrency')}</label>
            </div>
            <input
              class="immich-form-input w-full"
              aria-labelledby={$t('upload_concurrency')}
              id="upload-concurrency"
              name={$t('upload_concurrency')}
              type="number"
              min="1"
              max="50"
              step="1"
              bind:value={concurrency}
              onchange={() => setUploadConcurrency(concurrency)}
            />
          </div>
        {/if}
        <div class="flex max-h-[400px] immich-scrollbar flex-col gap-2 overflow-y-auto rounded-lg">
          {#each $uploadAssetsStore as uploadAsset (uploadAsset.id)}
            <UploadAssetPreview {uploadAsset} />
          {/each}
        </div>
      </div>
    {:else}
      <div class="rounded-full">
        <button
          type="button"
          in:scale={{ duration: 250, easing: quartInOut }}
          onclick={() => (showDetail = true)}
          class="absolute -inset-s-4 -top-4 flex size-10 place-content-center place-items-center rounded-full bg-primary p-5 text-xs text-light"
        >
          {$remainingUploads.toLocaleString($locale)}
        </button>
        {#if $stats.errors > 0}
          <button
            type="button"
            in:scale={{ duration: 250, easing: quartInOut }}
            onclick={() => (showDetail = true)}
            class="absolute -inset-e-4 -top-4 flex size-10 place-content-center place-items-center rounded-full bg-danger p-5 text-xs text-light"
          >
            {$stats.errors.toLocaleString($locale)}
          </button>
        {/if}
        <button
          type="button"
          in:scale={{ duration: 250, easing: quartInOut }}
          onclick={() => (showDetail = true)}
          aria-label={$t('upload_details')}
          class="relative flex size-16 place-content-center place-items-center rounded-full bg-subtle p-5 text-sm text-primary shadow-lg"
        >
          <svg class="pointer-events-none absolute inset-0 -rotate-90" viewBox="0 0 64 64" aria-hidden="true">
            <circle cx="32" cy="32" r="30" fill="none" stroke="currentColor" stroke-width="3" opacity="0.15" />
            <circle
              cx="32"
              cy="32"
              r="30"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
              stroke-linecap="round"
              stroke-dasharray={ringLength}
              stroke-dashoffset={ringLength * (1 - $progress.percent / 100)}
              class="transition-[stroke-dashoffset] duration-300 ease-out"
            />
          </svg>
          <div class={hasRemaining ? 'animate-pulse' : ''}>
            <Icon icon={mdiCloudUploadOutline} size="30" />
          </div>
        </button>
      </div>
    {/if}
  </div>
{/if}
