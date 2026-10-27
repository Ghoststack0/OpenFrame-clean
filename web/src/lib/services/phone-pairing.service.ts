import { modalManager, type ActionItem } from '@immich/ui';
import { mdiCellphoneLink } from '@mdi/js';
import type { MessageFormatter } from 'svelte-i18n';
import PhonePairingModal from '$lib/modals/PhonePairingModal.svelte';

export const getPhonePairingActions = ($t: MessageFormatter) => {
  const Connect: ActionItem = {
    title: $t('connect_phone'),
    icon: mdiCellphoneLink,
    onAction: () => modalManager.show(PhonePairingModal, {}),
  };

  return { Connect };
};
