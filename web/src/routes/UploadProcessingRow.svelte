<script lang="ts">
  import type { ProcessingRow, StageDisplayState } from '$lib/stores/upload-processing';
  import { AssetProcessingStage } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiAlertCircle,
    mdiCheckCircle,
    mdiCircleOutline,
    mdiClose,
    mdiLoading,
    mdiMinusCircleOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    row: ProcessingRow;
    onDismiss: (assetId: string) => void;
  }

  let { row, onDismiss }: Props = $props();

  const stageKeys = {
    [AssetProcessingStage.Uploaded]: 'asset_processing_stage_uploaded',
    [AssetProcessingStage.Metadata]: 'asset_processing_stage_metadata',
    [AssetProcessingStage.Thumbnails]: 'asset_processing_stage_thumbnails',
    [AssetProcessingStage.Video]: 'asset_processing_stage_video',
    [AssetProcessingStage.SmartSearch]: 'asset_processing_stage_smart_search',
    [AssetProcessingStage.Faces]: 'asset_processing_stage_faces',
  } as const;

  // Each state has its own icon so it never relies on colour alone.
  const states = {
    waiting: { icon: mdiCircleOutline, class: 'text-gray-400', label: 'asset_processing_state_waiting' },
    active: { icon: mdiLoading, class: 'text-primary', label: 'asset_processing_state_active' },
    complete: { icon: mdiCheckCircle, class: 'text-success', label: 'asset_processing_state_complete' },
    skipped: { icon: mdiMinusCircleOutline, class: 'text-gray-400', label: 'asset_processing_state_skipped' },
    failed: { icon: mdiAlertCircle, class: 'text-danger', label: 'asset_processing_state_failed' },
  } as const satisfies Record<StageDisplayState, { icon: string; class: string; label: string }>;

  const describe = (stage: AssetProcessingStage, state: StageDisplayState) =>
    $t('asset_processing_stage_status', {
      values: { stage: $t(stageKeys[stage]), state: $t(states[state].label) },
    });

  // One line naming what needs attention: the first failed stage, else the first stage in progress.
  let caption = $derived(
    row.stages.find(({ state }) => state === 'failed') ?? row.stages.find(({ state }) => state === 'active'),
  );
</script>

<li
  class="flex flex-col gap-1 rounded-xl border border-gray-300 bg-primary/10 p-2 text-xs dark:border-subtle"
  style="content-visibility: auto; contain-intrinsic-size: auto 56px"
>
  <div class="flex items-center gap-2">
    <span class="grow break-all">{row.name}</span>
    {#if row.failed}
      <button
        type="button"
        class="rounded-full"
        onclick={() => onDismiss(row.assetId)}
        aria-label={$t('asset_processing_dismiss', { values: { name: row.name } })}
      >
        <Icon icon={mdiClose} size="20" aria-hidden="true" />
      </button>
    {/if}
  </div>
  <ul class="flex items-center gap-1.5" aria-label={$t('asset_processing_pipeline', { values: { name: row.name } })}>
    {#each row.stages as { stage, state } (stage)}
      {@const view = states[state]}
      <li title={describe(stage, state)} class="flex items-center">
        <Icon
          icon={view.icon}
          size="18"
          spin={state === 'active'}
          class="{view.class} motion-reduce:animate-none"
          aria-hidden="true"
        />
        <span class="sr-only">{describe(stage, state)}</span>
      </li>
    {/each}
    {#if caption}
      <li
        aria-hidden="true"
        class="ms-1 truncate {caption.state === 'failed' ? 'text-danger' : 'text-gray-500 dark:text-gray-400'}"
      >
        {describe(caption.stage, caption.state)}
      </li>
    {/if}
  </ul>
</li>
