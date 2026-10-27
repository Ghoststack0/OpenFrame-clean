<script lang="ts">
  import { listDeviceTargets, sendAssetsToDevice } from '$lib/services/device-transfer.service';
  import { DEVICE_TRANSFER_MAX_ASSETS, getDeviceIcon, getDeviceTransferErrorKind } from '$lib/utils/device-transfer';
  import { DeviceTransferAction, type SessionTargetResponseDto } from '@immich/sdk';
  import { Button, Icon, LoadingSpinner, Modal, ModalBody, ModalFooter, Text, toastManager } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    assetIds: string[];
    onClose: () => void;
  };

  const { assetIds, onClose }: Props = $props();

  let targets = $state<SessionTargetResponseDto[]>([]);
  let loading = $state(true);
  let loadFailed = $state(false);
  let action = $state<DeviceTransferAction>(DeviceTransferAction.Open);
  let sendingTo = $state<string>();

  const tooMany = $derived(assetIds.length > DEVICE_TRANSFER_MAX_ASSETS);
  const busy = $derived(sendingTo !== undefined);

  const loadTargets = async () => {
    loading = true;
    loadFailed = false;
    try {
      targets = await listDeviceTargets();
    } catch (error) {
      console.error('Failed to load device targets', error);
      loadFailed = true;
    } finally {
      loading = false;
    }
  };

  const send = async (target: SessionTargetResponseDto) => {
    if (tooMany || busy) {
      return;
    }

    sendingTo = target.id;
    try {
      await sendAssetsToDevice({ targetSessionId: target.id, assetIds, action });
      toastManager.primary($t('device_transfer_sent', { values: { count: assetIds.length, device: target.label } }));
      onClose();
    } catch (error) {
      console.error('Failed to send assets to device', error);
      const kind = getDeviceTransferErrorKind(error);
      const device = target.label;
      const messages = {
        unavailable: $t('device_transfer_error_unavailable', { values: { device } }),
        offline: $t('device_transfer_error_offline', { values: { device } }),
        invalid: $t('device_transfer_error_invalid'),
        unknown: $t('device_transfer_error_unknown'),
      };
      toastManager.danger(messages[kind]);
      if (kind === 'unavailable' || kind === 'offline') {
        // the device went away, so refresh the list instead of leaving a dead entry
        await loadTargets();
      }
    } finally {
      sendingTo = undefined;
    }
  };

  onMount(loadTargets);
</script>

<Modal title={$t('send_to_device')} size="small" {onClose}>
  <ModalBody>
    <div class="flex flex-col gap-4">
      {#if tooMany}
        <p class="text-sm text-danger" role="alert">
          {$t('device_transfer_too_many', { values: { max: DEVICE_TRANSFER_MAX_ASSETS } })}
        </p>
      {/if}

      <fieldset class="flex flex-col gap-2" disabled={busy}>
        <legend class="mb-1 text-sm font-medium">{$t('device_transfer_action_label')}</legend>
        <label class="flex items-center gap-2 text-sm">
          <input type="radio" name="device-transfer-action" value={DeviceTransferAction.Open} bind:group={action} />
          {$t('device_transfer_action_open')}
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="radio" name="device-transfer-action" value={DeviceTransferAction.Download} bind:group={action} />
          {$t('device_transfer_action_download')}
        </label>
      </fieldset>

      <div aria-live="polite" aria-busy={loading}>
        <p class="mb-2 text-sm font-medium">
          {$t('device_transfer_pick_device', { values: { count: assetIds.length } })}
        </p>

        {#if loading}
          <div class="flex justify-center py-6" role="status" aria-label={$t('loading')}>
            <LoadingSpinner />
          </div>
        {:else if loadFailed}
          <div class="flex flex-col items-start gap-3 py-2" role="alert">
            <Text color="danger">{$t('device_transfer_load_error')}</Text>
            <Button size="small" shape="round" color="secondary" onclick={loadTargets}>{$t('retry')}</Button>
          </div>
        {:else if targets.length === 0}
          <p class="py-2 text-sm text-gray-600 dark:text-gray-300">{$t('device_transfer_empty')}</p>
        {:else}
          <ul class="flex flex-col gap-1">
            {#each targets as target (target.id)}
              <li>
                <button
                  type="button"
                  class="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-start hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-700"
                  disabled={tooMany || busy}
                  onclick={() => send(target)}
                >
                  <Icon icon={getDeviceIcon(target)} size="28" class="shrink-0 text-primary" aria-hidden />
                  <span class="min-w-0 grow truncate text-sm">{target.label}</span>
                  {#if sendingTo === target.id}
                    <LoadingSpinner size="small" />
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  </ModalBody>
  <ModalFooter>
    <Button shape="round" color="secondary" fullWidth onclick={onClose}>{$t('cancel')}</Button>
  </ModalFooter>
</Modal>
