<script lang="ts">
  import Qrcode from '$lib/components/shared-components/Qrcode.svelte';
  import { getSessionsQuery } from '$lib/queries/session.query';
  import { queryClient } from '$lib/queries/client';
  import { createPhonePairing, waitForPhonePairing } from '$lib/services/phone-pairing';
  import { PairingState } from '@immich/sdk';
  import { Button, Icon, LoadingSpinner, Modal, ModalBody, Text } from '@immich/ui';
  import {
    mdiAlertCircleOutline,
    mdiCellphoneLink,
    mdiCheckCircleOutline,
    mdiLockOutline,
    mdiTimerOffOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    onClose: () => void;
  };

  type View = 'creating' | 'pending' | 'redeemed' | 'expired' | 'locked' | 'error';

  const { onClose }: Props = $props();

  const QR_SIZE = 240;
  const SUCCESS_CLOSE_DELAY = 2000;

  let view = $state<View>('creating');
  // The pairing holds the bearer credential. It is only kept while the QR is shown.
  let pairing = $state.raw<Awaited<ReturnType<typeof createPhonePairing>>>();
  let now = $state(Date.now());

  let abortController: AbortController | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const remainingMs = $derived(pairing ? Math.max(0, Date.parse(pairing.expiresAt) - now) : 0);
  const remaining = $derived.by(() => {
    const seconds = Math.ceil(remainingMs / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  });

  const stop = () => {
    abortController?.abort();
    abortController = undefined;
    clearTimeout(closeTimer);
    closeTimer = undefined;
    pairing = undefined;
  };

  const close = () => {
    stop();
    onClose();
  };

  const start = async () => {
    stop();
    const controller = new AbortController();
    abortController = controller;
    view = 'creating';

    try {
      const created = await createPhonePairing();
      if (controller.signal.aborted) {
        return;
      }

      now = Date.now();
      pairing = created;
      view = 'pending';

      const status = await waitForPhonePairing(created, controller.signal);
      if (controller.signal.aborted) {
        return;
      }

      pairing = undefined;
      switch (status) {
        case PairingState.Redeemed: {
          view = 'redeemed';
          await queryClient.invalidateQueries({ queryKey: getSessionsQuery().queryKey });
          if (!controller.signal.aborted) {
            closeTimer = setTimeout(close, SUCCESS_CLOSE_DELAY);
          }
          break;
        }
        case PairingState.Locked: {
          view = 'locked';
          break;
        }
        default: {
          view = 'expired';
        }
      }
    } catch {
      // Do not log: keep the credential and request details out of the console.
      if (!controller.signal.aborted) {
        pairing = undefined;
        view = 'error';
      }
    }
  };

  onMount(() => {
    void start();
    return stop;
  });

  $effect(() => {
    if (view !== 'pending') {
      return;
    }

    const interval = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(interval);
  });

  const states = $derived({
    creating: { title: $t('connect_phone_creating'), description: undefined, icon: undefined },
    pending: { title: $t('connect_phone_waiting'), description: undefined, icon: undefined },
    redeemed: {
      title: $t('connect_phone_success'),
      description: $t('connect_phone_success_description'),
      icon: mdiCheckCircleOutline,
    },
    expired: {
      title: $t('connect_phone_expired'),
      description: $t('connect_phone_expired_description'),
      icon: mdiTimerOffOutline,
    },
    locked: {
      title: $t('connect_phone_locked'),
      description: $t('connect_phone_locked_description'),
      icon: mdiLockOutline,
    },
    error: {
      title: $t('connect_phone_error'),
      description: $t('connect_phone_error_description'),
      icon: mdiAlertCircleOutline,
    },
  } satisfies Record<View, { title: string; description?: string; icon?: string }>);
  const current = $derived(states[view]);
</script>

<Modal title={$t('connect_phone')} icon={mdiCellphoneLink} onClose={close} size="small" focusOnOpen>
  <ModalBody>
    <div class="flex flex-col items-center gap-4 pb-4">
      <Text size="small" class="text-center">{$t('connect_phone_instructions')}</Text>

      <div class="flex items-center justify-center" style="width: {QR_SIZE}px; height: {QR_SIZE}px">
        {#if view === 'pending' && pairing}
          <div class="overflow-hidden rounded-2xl bg-white">
            <Qrcode value={pairing.payload} width={QR_SIZE} alt={$t('connect_phone_qr_alt')} />
          </div>
        {:else}
          <div
            class="flex size-full flex-col items-center justify-center rounded-2xl border border-dashed border-gray-300 bg-subtle text-primary dark:border-gray-600"
          >
            {#if current.icon}
              <Icon icon={current.icon} size="64" aria-hidden />
            {:else}
              <LoadingSpinner />
            {/if}
          </div>
        {/if}
      </div>

      <div class="flex flex-col items-center gap-1 text-center" role="status" aria-live="polite">
        <Text fontWeight="medium">{current.title}</Text>
        {#if current.description}
          <Text size="small" color="muted">{current.description}</Text>
        {/if}
      </div>

      {#if view === 'pending' && pairing}
        <p role="timer" class="text-sm text-gray-600 tabular-nums dark:text-gray-300">
          {$t('connect_phone_expires_in', { values: { time: remaining } })}
        </p>

        <div class="w-full text-center">
          <Text size="tiny" color="muted">{$t('connect_phone_server_urls')}</Text>
          <ul class="mt-1 flex flex-col gap-1">
            {#each pairing.serverUrls as serverUrl (serverUrl)}
              <li class="font-mono text-sm break-all dark:text-white">{serverUrl}</li>
            {/each}
          </ul>
        </div>

        <Text size="tiny" color="muted" class="text-center">{$t('connect_phone_warning')}</Text>
      {:else if ['expired', 'locked', 'error'].includes(view)}
        <Button shape="round" onclick={start}>{$t('generate_new_code')}</Button>
      {/if}
    </div>
  </ModalBody>
</Modal>
