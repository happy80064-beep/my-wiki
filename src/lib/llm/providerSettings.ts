import { isTauriRuntime } from '@/lib/runtime/tauri';
import {
  createDefaultProviderConfig,
  DEFAULT_MODEL_ROLES,
  capabilityLabel,
  getProviderModelPreset,
  LLM_PROVIDER_PRESETS,
  ROLE_REQUIRED_CAPABILITIES,
  validateLlmProviderConfig,
  type LlmProviderConfig,
  type LlmProviderId,
  type ModelRoleId,
} from './providers';

export type LlmProviderSettings = {
  configs: LlmProviderConfig[];
  activeProviderId: LlmProviderId | null;
  roleAssignments: Partial<Record<ModelRoleId, LlmProviderId>>;
};

const storageKey = 'mywiki.v2.llmProviderSettings';
const productionTauriStorageKey = 'mywiki.v2.production.llmProviderSettings';

export function createDefaultProviderSettings(): LlmProviderSettings {
  return {
    configs: LLM_PROVIDER_PRESETS.map((preset) => createDefaultProviderConfig(preset.id)),
    activeProviderId: null,
    roleAssignments: {},
  };
}

export function normalizeProviderSettings(input: unknown): LlmProviderSettings {
  const defaults = createDefaultProviderSettings();
  if (!isObject(input)) return defaults;

  const rawConfigs = Array.isArray(input.configs) ? input.configs : [];
  const configs = defaults.configs.map((defaultConfig) => {
    const incoming = rawConfigs.find((item) => isObject(item) && item.providerId === defaultConfig.providerId);
    if (!isObject(incoming)) return defaultConfig;
    return {
      ...defaultConfig,
      ...incoming,
      enabled: Boolean(incoming.enabled),
      apiKey: typeof incoming.apiKey === 'string' ? incoming.apiKey : '',
      endpoint: typeof incoming.endpoint === 'string' ? incoming.endpoint : defaultConfig.endpoint,
      model: typeof incoming.model === 'string' ? incoming.model : defaultConfig.model,
      contextWindow: typeof incoming.contextWindow === 'number' ? incoming.contextWindow : defaultConfig.contextWindow,
    };
  });

  const activeProviderId = providerExists(input.activeProviderId) ? input.activeProviderId : null;
  const roleAssignments: Partial<Record<ModelRoleId, LlmProviderId>> = {};
  if (isObject(input.roleAssignments)) {
    for (const role of DEFAULT_MODEL_ROLES) {
      const providerId = input.roleAssignments[role.id];
      if (providerExists(providerId)) roleAssignments[role.id] = providerId;
    }
  }

  return {
    configs: configs.map((config) => ({
      ...config,
      enabled: activeProviderId === config.providerId ? config.enabled : false,
    })),
    activeProviderId,
    roleAssignments,
  };
}

export function activateProvider(settings: LlmProviderSettings, providerId: LlmProviderId | null): LlmProviderSettings {
  return {
    ...settings,
    activeProviderId: providerId,
    configs: settings.configs.map((config) => ({
      ...config,
      enabled: providerId === config.providerId,
    })),
  };
}

export function updateProviderConfig(
  settings: LlmProviderSettings,
  providerId: LlmProviderId,
  patch: Partial<LlmProviderConfig>,
): LlmProviderSettings {
  return {
    ...settings,
    configs: settings.configs.map((config) =>
      config.providerId === providerId
        ? {
            ...config,
            ...patch,
            providerId: config.providerId,
          }
        : config,
    ),
  };
}

export function assignModelRole(
  settings: LlmProviderSettings,
  roleId: ModelRoleId,
  providerId: LlmProviderId | '',
): LlmProviderSettings {
  const nextAssignments = { ...settings.roleAssignments };
  if (providerId) nextAssignments[roleId] = providerId;
  else delete nextAssignments[roleId];
  return { ...settings, roleAssignments: nextAssignments };
}

export function getActiveProviderConfig(settings: LlmProviderSettings) {
  return settings.configs.find((config) => config.providerId === settings.activeProviderId) ?? null;
}

export type ProviderRoleResolution = {
  config: LlmProviderConfig | null;
  source: 'assigned' | 'active' | 'none';
  error?: string;
};

export function getProviderConfigForRole(settings: LlmProviderSettings, roleId: ModelRoleId) {
  return resolveProviderConfigForRole(settings, roleId).config;
}

export function resolveProviderConfigForRole(settings: LlmProviderSettings, roleId: ModelRoleId): ProviderRoleResolution {
  const providerId = settings.roleAssignments[roleId] ?? settings.activeProviderId;
  const source = settings.roleAssignments[roleId] ? 'assigned' : settings.activeProviderId ? 'active' : 'none';
  if (!providerId) return { config: null, source: 'none' };

  const config = settings.configs.find((item) => item.providerId === providerId);
  if (!config) return { config: null, source };

  const capabilityError = validateProviderRoleCapability(providerId, roleId, source, config.model);
  if (capabilityError) {
    return { config: null, source, error: capabilityError };
  }

  return { config: { ...config, enabled: true }, source };
}

export function validateProviderRoleCapability(
  providerId: LlmProviderId,
  roleId: ModelRoleId,
  source: 'assigned' | 'active' | 'none' = 'assigned',
  modelId?: string,
) {
  const preset = LLM_PROVIDER_PRESETS.find((item) => item.id === providerId);
  if (!preset) return `未知模型 Provider：${providerId}`;
  const providerLabel = preset.label;
  const sourceLabel = source === 'active' ? '当前默认模型' : '已选择的模型';
  const configuredModel = modelId?.trim();

  if (!configuredModel) {
    return `${sourceLabel} ${providerLabel} 尚未填写模型 ID。`;
  }

  const requiredCapabilities = ROLE_REQUIRED_CAPABILITIES[roleId];
  const modelPreset = getProviderModelPreset(providerId, configuredModel);

  if (modelPreset) {
    const missingCapabilities = requiredCapabilities.filter((capability) => !modelPreset.capabilities.includes(capability));
    if (missingCapabilities.length > 0) {
      return `${sourceLabel} ${providerLabel} / ${configuredModel} 不支持 ${missingCapabilities
        .map(capabilityLabel)
        .join('、')} 职责。请切换为具备该能力的模型 ID。`;
    }
    return '';
  }

  const customProvider = providerId === 'custom-openai' || providerId === 'custom-anthropic';
  if (customProvider) {
    if (roleId === 'vision' && !preset.supportsVision) {
      return `${sourceLabel} ${providerLabel} 不支持图片/多模态职责。请为“图片/多模态模型”选择支持 Vision 的模型，或更换默认模型。`;
    }
    if (roleId === 'embedding' && !preset.supportsEmbedding) {
      return `${sourceLabel} ${providerLabel} 不支持 Embedding 职责。请为“Embedding 模型”选择支持 Embedding 的模型，或暂时不要启用向量检索。`;
    }
    return '';
  }

  if (roleId === 'vision' || roleId === 'embedding') {
    return `${sourceLabel} ${providerLabel} / ${configuredModel} 未收录在模型能力目录中，无法确认是否支持 ${requiredCapabilities
      .map(capabilityLabel)
      .join('、')} 职责。请从该厂商的推荐模型 ID 中选择，或先更新模型目录。`;
  }

  return '';
}

export function validateActiveProvider(settings: LlmProviderSettings) {
  const active = getActiveProviderConfig(settings);
  if (!active) return [];
  return validateLlmProviderConfig(active);
}

export function loadProviderSettings(storage: Pick<Storage, 'getItem'> = window.localStorage) {
  const raw = storage.getItem(getProviderSettingsStorageKey());
  if (!raw) return createDefaultProviderSettings();
  try {
    return normalizeProviderSettings(JSON.parse(raw));
  } catch {
    return createDefaultProviderSettings();
  }
}

export function saveProviderSettings(settings: LlmProviderSettings, storage: Pick<Storage, 'setItem'> = window.localStorage) {
  storage.setItem(getProviderSettingsStorageKey(), JSON.stringify(settings, null, 2));
}

export function getProviderSettingsStorageKey() {
  return isInstalledTauriRuntime() ? productionTauriStorageKey : storageKey;
}

function isInstalledTauriRuntime() {
  return !import.meta.env.DEV && isTauriRuntime();
}

function providerExists(value: unknown): value is LlmProviderId {
  return typeof value === 'string' && LLM_PROVIDER_PRESETS.some((preset) => preset.id === value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
