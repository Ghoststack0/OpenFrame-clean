<script lang="ts">
  import { goto } from '$app/navigation';
  import { Route } from '$lib/route';
  import { listDeviceTargets } from '$lib/services/device-transfer.service';
  import { deviceTransferStore } from '$lib/stores/device-transfer.store';
  import { downloadArchive } from '$lib/utils/asset-utils';
  import { getDeviceIcon } from '$lib/utils/device-transfer';
  import { DeviceTransferAction, type DeviceTransferResponseDto, type SessionTargetResponseDto } from '@immich/sdk';
  import { Button, Icon, IconButton } from '@immich/ui';
  import { mdiClose } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { SvelteSet } from 'svelte/reactivity';
  import { fly } from 'svelte/transition';

  let sources = $state<Record<string, SessionTargetResponseDto | undefined>>({});
  const requested = new SvelteSet<string>();

  // The event only carries the source session ID, so resolve its label from the online targets.
  $effect(() => {
    const unknown = $deviceTransferStore.filter(({ sourceSessionId }) => !requested.has(sourceSessionId));
    if (unknown.length === 0) {
      return;
    }
    for (const { sourceSessionId } of unknown) {
      requested.add(sourceSessionId);
    }
    listDeviceTargets()
      .then((targets) => {
        sources = { ...sources, ...Object.fromEntries(targets.map((target) => [target.id, target])) };
      })
      .catch((error) => {
        // the card falls back to a generic device name; retrying here would loop, as the effect tracks `requested`
        console.error('Failed to resolve device transfer source', error);
      });
  });

  const handleOpen = async (transfer: DeviceTransferResponseDto) => {
    deviceTransferStore.dismiss(transfer.id);
    await goto(Route.viewAsset({ id: transfer.assetIds[0] }));
  };

  const handleDownload = async (transfer: DeviceTransferResponseDto) => {
    deviceTransferStore.dismiss(transfer.id);
    await downloadArchive('openframe-transfer', { assetIds: transfer.assetIds });
  };

  const onkeydown = (event: KeyboardEvent, transfer: DeviceTransferResponseDto) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      deviceTransferStore.dismiss(transfer.id);
    }
  };
</script>

{#if $deviceTransferStore.length > 0}
  <section
    class="fixed inset-e-2 top-20 z-60 flex max-h-[70vh] w-80 max-w-[calc(100vw-1rem)] flex-col gap-2 overflow-y-auto"
    aria-label={$t('device_transfer_incoming')}
  >
    {#each $deviceTransferStore as transfer (transfer.id)}
      {@const source = sources[transfer.sourceSessionId]}
      {@const device = source?.label ?? $t('device_transfer_unknown_device')}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        role="status"
        class="rounded-2xl border bg-subtle p-4 shadow-lg dark:border-white/10"
        data-testid="device-transfer-card"
        transition:fly={{ x: 100, duration: 250 }}
        onkeydown={(event) => onkeydown(event, transfer)}
      >
        <div class="flex items-start gap-3">
          <Icon
            icon={getDeviceIcon(source ?? { deviceType: '', deviceOS: '' })}
            size="24"
            class="mt-0.5 shrink-0 text-primary"
            aria-hidden
          />
          <p class="min-w-0 grow text-sm font-medium">
            {$t('device_transfer_received', { values: { device, count: transfer.assetIds.length } })}
          </p>
          <IconButton
            icon={mdiClose}
            size="small"
            shape="round"
            color="secondary"
            variant="ghost"
            aria-label={$t('device_transfer_dismiss')}
            onclick={() => deviceTransferStore.dismiss(transfer.id)}
          />
        </div>
        <div class="mt-3 flex justify-end gap-2">
          {#if transfer.action === DeviceTransferAction.Open}
            <Button size="small" shape="round" onclick={() => handleOpen(transfer)}>{$t('open')}</Button>
          {:else}
            <Button size="small" shape="round" onclick={() => handleDownload(transfer)}>{$t('download')}</Button>
          {/if}
        </div>
      </div>
    {/each}

    {#if $deviceTransferStore.length > 1}
      <Button size="small" shape="round" color="secondary" onclick={() => deviceTransferStore.clear()}>
        {$t('device_transfer_dismiss_all')}
      </Button>
    {/if}
  </section>
{/if}
