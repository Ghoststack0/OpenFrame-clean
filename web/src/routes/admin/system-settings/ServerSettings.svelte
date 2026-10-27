<script lang="ts">
  import { createPreloadedQuery } from '$lib/queries/client';
  import { getAdminConfigQuery } from '$lib/queries/config-admin.query';
  import { cloneDeep, isEqual } from 'lodash-es';
  import SettingButtonsRow from '$lib/components/shared-components/settings/SystemConfigButtonRow.svelte';
  import SettingInputField from '$lib/components/shared-components/settings/SettingInputField.svelte';
  import SettingSwitch from '$lib/components/shared-components/settings/SettingSwitch.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { isValidLocalUrl } from '$lib/utils/local-url';
  import { Button, IconButton, toastManager } from '@immich/ui';
  import { mdiPlus, mdiTrashCanOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { quintOut } from 'svelte/easing';
  import { fade, fly } from 'svelte/transition';

  const MAX_LOCAL_URLS = 16;

  const query = createPreloadedQuery(getAdminConfigQuery);
  const config = $derived(query.data);

  const disabled = $derived(featureFlagsManager.value.configFile);
  let configToEdit = $state(cloneDeep(config));

  // The generated type marks localUrls optional, but the server always returns it.
  const localUrls = $derived(configToEdit.server.localUrls ?? []);
  const savedLocalUrls = $derived(config.server.localUrls ?? []);

  const addLocalUrl = () => (configToEdit.server.localUrls = [...localUrls, '']);
  const updateLocalUrl = (index: number, value: string) =>
    (configToEdit.server.localUrls = localUrls.map((url, i) => (i === index ? value : url)));
  const removeLocalUrl = (index: number) => (configToEdit.server.localUrls = localUrls.filter((_, i) => i !== index));

  const onBeforeSave = () => {
    const isValid = localUrls.every((url) => isValidLocalUrl(url));
    if (!isValid) {
      toastManager.warning($t('admin.server_local_urls_invalid'));
    }

    return Promise.resolve(isValid);
  };
</script>

<div>
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
      <div class="ms-4 mt-4">
        <SettingInputField
          inputType={SettingInputFieldType.TEXT}
          label={$t('admin.server_external_domain_settings')}
          description={$t('admin.server_external_domain_settings_description')}
          bind:value={configToEdit.server.externalDomain}
          isEdited={configToEdit.server.externalDomain !== config.server.externalDomain}
        />

        <div class="mb-4 w-full">
          <div class="flex h-6.5 place-items-center gap-1">
            <span class="text-sm font-medium text-primary">{$t('admin.server_local_urls')}</span>

            {#if !isEqual(localUrls, savedLocalUrls)}
              <div
                transition:fly={{ x: 10, duration: 200, easing: quintOut }}
                class="rounded-full bg-orange-100 px-2 text-[10px] text-orange-900"
              >
                {$t('unsaved_change')}
              </div>
            {/if}
          </div>

          <p class="pb-2 text-sm immich-form-label">{$t('admin.server_local_urls_description')}</p>

          {#each localUrls as _, i (i)}
            <SettingInputField
              inputType={SettingInputFieldType.TEXT}
              title={$t('url')}
              bind:value={() => localUrls[i], (value) => updateLocalUrl(i, value)}
              {disabled}
            >
              {#snippet trailingSnippet()}
                <IconButton
                  aria-label={$t('remove')}
                  onclick={() => removeLocalUrl(i)}
                  icon={mdiTrashCanOutline}
                  color="danger"
                  {disabled}
                />
              {/snippet}
            </SettingInputField>
          {/each}

          <div class="flex justify-end">
            <Button
              size="small"
              shape="round"
              leadingIcon={mdiPlus}
              onclick={addLocalUrl}
              disabled={disabled || localUrls.length >= MAX_LOCAL_URLS}
            >
              {$t('add_url')}
            </Button>
          </div>
        </div>

        <div class="mb-4">
          <SettingSwitch
            title={$t('admin.server_auto_detect_local_urls')}
            subtitle={$t('admin.server_auto_detect_local_urls_description')}
            {disabled}
            isEdited={configToEdit.server.autoDetectLocalUrls !== config.server.autoDetectLocalUrls}
            bind:checked={configToEdit.server.autoDetectLocalUrls}
          />
        </div>

        <SettingInputField
          inputType={SettingInputFieldType.TEXT}
          label={$t('admin.server_welcome_message')}
          description={$t('admin.server_welcome_message_description')}
          bind:value={configToEdit.server.loginPageMessage}
          isEdited={configToEdit.server.loginPageMessage !== config.server.loginPageMessage}
        />

        <SettingSwitch
          title={$t('admin.server_public_users')}
          subtitle={$t('admin.server_public_users_description')}
          {disabled}
          bind:checked={configToEdit.server.publicUsers}
        />

        <div class="ms-4">
          <SettingButtonsRow bind:configToEdit keys={['server']} {disabled} {onBeforeSave} />
        </div>
      </div>
    </form>
  </div>
</div>
