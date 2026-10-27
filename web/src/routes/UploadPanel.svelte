<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { uploadAssetsStore } from '$lib/stores/upload';
  import {
    clearFinishedProcessing,
    dismissProcessing,
    hideAllProcessing,
    processingRows,
    processingSummary,
  } from '$lib/stores/upload-processing';
  import { UploadState } from '$lib/types';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { uploadExecutionQueue } from '$lib/utils/file-uploader';
  import { acquireWakeLock, releaseWakeLock } from '$lib/utils/wakelock.svelte';
  import { Button, Icon, IconButton, toastManager } from '@immich/ui';
  import { mdiAlertCircle, mdiCancel, mdiCloudUploadOutline, mdiCog, mdiWindowMinimize } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { get } from 'svelte/store';
  import { quartInOut } from 'svelte/easing';
  import { fade, scale } from 'svelte/transition';
  import UploadAssetPreview from './UploadAssetPreview.svelte';
  import UploadProcessingRow from './UploadProcessingRow.svelte';

  let showDetail = $state(false);
  let showOptions = $state(false);
  let concurrency = $state(uploadExecutionQueue.concurrency);

  let { stats, progress, isDismissible, isUploading, remainingUploads } = uploadAssetsStore;

  // Circumference of the progress ring drawn around the minimized button (r = 30)
  const ringLength = 2 * Math.PI * 30;

  // How long a fully processed batch stays visible before the panel closes itself
  const FINISHED_LINGER_MS = 3000;

  let hasRemaining = $derived($remainingUploads > 0);
  let hasProcessing = $derived($processingSummary.total > 0);
  // Bytes are done but the server is still working
  let isProcessingOnly = $derived(!hasRemaining && $processingSummary.active > 0);
  let isAdmin = $derived(authManager.authenticated && authManager.user.isAdmin);

  // Finished uploads are listed with their processing pipeline instead, so skip their upload row.
  let processingIds = $derived(new Set($processingRows.map((row) => row.assetId)));
  let uploadItems = $derived(
    $uploadAssetsStore.filter(
      (item) => !(item.state === UploadState.DONE && item.assetId && processingIds.has(item.assetId)),
    ),
  );

  let summaryText = $derived.by(() => {
    const { total, finished, failed, active } = $processingSummary;
    if (active === 0) {
      return failed > 0
        ? $t('asset_processing_finished_failed', { values: { failed } })
        : $t('asset_processing_complete');
    }
    const processed = finished + failed;
    return failed > 0
      ? $t('asset_processing_summary_failed', { values: { processed, total, failed } })
      : $t('asset_processing_summary', { values: { processed, total } });
  });

  $effect(() => {
    if ($isUploading) {
      showDetail = true;
    }
  });

  // Report the upload result once the last file settles, even if processing is still running.
  let wasUploading = false;
  $effect(() => {
    if ($isUploading) {
      wasUploading = true;
      return;
    }
    if (!wasUploading) {
      return;
    }
    wasUploading = false;
    const current = get(stats);
    if (current.errors > 0) {
      toastManager.danger($t('upload_errors', { values: { count: current.errors } }));
    } else if (current.success > 0) {
      toastManager.primary($t('upload_success'));
    }
    if (current.duplicates > 0) {
      toastManager.warning($t('upload_skipped_duplicates', { values: { count: current.duplicates } }));
    }
    uploadAssetsStore.reset();
  });

  // Nothing left to look at once everything is processed without failures.
  $effect(() => {
    if ($isUploading || $processingSummary.active > 0 || $processingSummary.failed > 0 || !hasProcessing) {
      return;
    }
    const timeout = setTimeout(clearFinishedProcessing, FINISHED_LINGER_MS);
    return () => clearTimeout(timeout);
  });

  $effect(() => {
    if (hasRemaining) {
      void acquireWakeLock();
    } else {
      void releaseWakeLock();
    }
  });
</script>

{#if $isUploading || hasProcessing}
  <div in:fade={{ duration: 250 }} out:fade={{ duration: 250 }} class="fixed inset-e-16 bottom-6 z-60">
    {#if showDetail}
      <div
        in:scale={{ duration: 250, easing: quartInOut }}
        class="w-81 rounded-xl border border-gray-200 bg-subtle p-4 text-sm shadow-xs dark:border-subtle"
      >
        <div class="place-item-center mb-4 flex justify-between">
          <div class="flex flex-col gap-1">
            {#if $isUploading}
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
            {/if}
            {#if hasProcessing}
              <p class="text-xm immich-form-label" role="status" aria-live="polite" aria-atomic="true">
                {summaryText}
              </p>
            {/if}
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
        {#if $isUploading}
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
          </div>
        {/if}
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
              onchange={() => (uploadExecutionQueue.concurrency = concurrency)}
            />
          </div>
        {/if}
        {#if $processingSummary.failed > 0}
          <p class="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-danger">
            <Icon icon={mdiAlertCircle} size="18" aria-hidden="true" />
            <span>{$t('asset_processing_failed_count', { values: { count: $processingSummary.failed } })}</span>
            {#if isAdmin}
              <a href={Route.queues()} class="font-medium underline">{$t('asset_processing_view_jobs')}</a>
            {/if}
          </p>
        {/if}
        <div class="flex max-h-[400px] immich-scrollbar flex-col gap-2 overflow-y-auto rounded-lg">
          {#each uploadItems as uploadAsset (uploadAsset.id)}
            <UploadAssetPreview {uploadAsset} />
          {/each}
          {#if hasProcessing}
            <ul class="flex flex-col gap-2">
              {#each $processingRows as row (row.assetId)}
                <UploadProcessingRow {row} onDismiss={dismissProcessing} />
              {/each}
            </ul>
          {/if}
        </div>
        {#if hasProcessing}
          <div class="mt-4 flex justify-end gap-2">
            {#if isProcessingOnly}
              <!-- Processing can wait on a long ML backlog; let the user stop following it. -->
              <Button size="small" shape="round" color="secondary" variant="ghost" onclick={hideAllProcessing}>
                {$t('asset_processing_hide')}
              </Button>
            {/if}
            {#if $processingSummary.finished > 0}
              <Button size="small" shape="round" color="secondary" onclick={clearFinishedProcessing}>
                {$t('clear_finished')}
              </Button>
            {/if}
          </div>
        {/if}
      </div>
    {:else}
      <div class="rounded-full">
        {#if hasRemaining || $processingSummary.active > 0}
          <button
            type="button"
            in:scale={{ duration: 250, easing: quartInOut }}
            onclick={() => (showDetail = true)}
            class="absolute -inset-s-4 -top-4 flex size-10 place-content-center place-items-center rounded-full bg-primary p-5 text-xs text-light"
          >
            {(hasRemaining ? $remainingUploads : $processingSummary.active).toLocaleString($locale)}
          </button>
        {/if}
        {#if $stats.errors + $processingSummary.failed > 0}
          <button
            type="button"
            in:scale={{ duration: 250, easing: quartInOut }}
            onclick={() => (showDetail = true)}
            class="absolute -inset-e-4 -top-4 flex size-10 place-content-center place-items-center rounded-full bg-danger p-5 text-xs text-light"
          >
            {($stats.errors + $processingSummary.failed).toLocaleString($locale)}
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
            {#if !isProcessingOnly}
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
            {/if}
          </svg>
          {#if isProcessingOnly}
            <!-- Bytes are done: a short arc circles the ring while the server processes the uploads -->
            <svg
              class="pointer-events-none absolute inset-0 motion-safe:animate-spin"
              viewBox="0 0 64 64"
              aria-hidden="true"
              data-testid="processing-ring"
            >
              <circle
                cx="32"
                cy="32"
                r="30"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-dasharray="{ringLength * 0.25} {ringLength}"
              />
            </svg>
          {/if}
          <div class={hasRemaining || isProcessingOnly ? 'animate-pulse' : ''}>
            <Icon icon={mdiCloudUploadOutline} size="30" />
          </div>
        </button>
      </div>
    {/if}
  </div>
{/if}
