import { describe, expect, it } from 'vitest';
import {
  activateProvider,
  assignModelRole,
  createDefaultProviderSettings,
  getProviderConfigForRole,
  loadProviderSettings,
  normalizeProviderSettings,
  resolveProviderConfigForRole,
  saveProviderSettings,
  updateProviderConfig,
  validateActiveProvider,
} from '@/lib/llm/providerSettings';

describe('provider settings', () => {
  it('creates one disabled config for every provider preset', () => {
    const settings = createDefaultProviderSettings();

    expect(settings.configs.length).toBeGreaterThan(8);
    expect(settings.activeProviderId).toBeNull();
    expect(settings.configs.every((config) => !config.enabled)).toBe(true);
  });

  it('activates exactly one provider while keeping other configs', () => {
    let settings = createDefaultProviderSettings();
    settings = updateProviderConfig(settings, 'minimax-cn', { apiKey: 'sk-mini' });
    settings = updateProviderConfig(settings, 'deepseek', { apiKey: 'sk-deep' });
    settings = activateProvider(settings, 'minimax-cn');

    expect(settings.activeProviderId).toBe('minimax-cn');
    expect(settings.configs.find((config) => config.providerId === 'minimax-cn')?.enabled).toBe(true);
    expect(settings.configs.find((config) => config.providerId === 'deepseek')?.enabled).toBe(false);
    expect(settings.configs.find((config) => config.providerId === 'deepseek')?.apiKey).toBe('sk-deep');
  });

  it('assigns model roles to provider configs', () => {
    let settings = createDefaultProviderSettings();
    settings = assignModelRole(settings, 'wiki-compile', 'minimax-cn');
    settings = assignModelRole(settings, 'vision', 'openai');

    expect(settings.roleAssignments).toMatchObject({
      'wiki-compile': 'minimax-cn',
      vision: 'openai',
    });

    settings = assignModelRole(settings, 'vision', '');
    expect(settings.roleAssignments.vision).toBeUndefined();
  });

  it('resolves a role-assigned provider before falling back to the active provider', () => {
    let settings = createDefaultProviderSettings();
    settings = updateProviderConfig(settings, 'minimax-cn', { apiKey: 'sk-mini', model: 'MiniMax-M2.7' });
    settings = updateProviderConfig(settings, 'openai', { apiKey: 'sk-openai', model: 'gpt-5.5' });
    settings = activateProvider(settings, 'openai');
    settings = assignModelRole(settings, 'wiki-compile', 'minimax-cn');

    expect(getProviderConfigForRole(settings, 'wiki-compile')).toMatchObject({
      providerId: 'minimax-cn',
      enabled: true,
      apiKey: 'sk-mini',
      model: 'MiniMax-M2.7',
    });
    expect(getProviderConfigForRole(settings, 'query-fast')).toMatchObject({
      providerId: 'openai',
      enabled: true,
      apiKey: 'sk-openai',
      model: 'gpt-5.5',
    });
  });

  it('uses the active provider when a role is not separately assigned', () => {
    let settings = createDefaultProviderSettings();
    settings = updateProviderConfig(settings, 'minimax-cn', { apiKey: 'sk-mini', model: 'MiniMax-M2.7' });
    settings = activateProvider(settings, 'minimax-cn');

    const resolution = resolveProviderConfigForRole(settings, 'wiki-compile');

    expect(resolution.source).toBe('active');
    expect(resolution.config).toMatchObject({
      providerId: 'minimax-cn',
      enabled: true,
      apiKey: 'sk-mini',
      model: 'MiniMax-M2.7',
    });
  });

  it('reports when the default provider cannot satisfy the vision role', () => {
    const settings = activateProvider(createDefaultProviderSettings(), 'deepseek');
    const resolution = resolveProviderConfigForRole(settings, 'vision');

    expect(resolution.source).toBe('active');
    expect(resolution.config).toBeNull();
    expect(resolution.error).toContain('不支持 视觉 职责');
  });

  it('reports when the selected provider cannot satisfy the embedding role', () => {
    let settings = createDefaultProviderSettings();
    settings = activateProvider(settings, 'openai');
    settings = assignModelRole(settings, 'embedding', 'minimax-cn');

    const resolution = resolveProviderConfigForRole(settings, 'embedding');

    expect(resolution.source).toBe('assigned');
    expect(resolution.config).toBeNull();
    expect(resolution.error).toContain('不支持 Embedding 职责');
  });

  it('checks the configured model id for provider role capability', () => {
    let settings = createDefaultProviderSettings();
    settings = updateProviderConfig(settings, 'zhipu', { apiKey: 'sk-zhipu', model: 'glm-4.6' });
    settings = assignModelRole(settings, 'vision', 'zhipu');

    expect(resolveProviderConfigForRole(settings, 'vision').error).toContain('不支持 视觉 职责');

    settings = updateProviderConfig(settings, 'zhipu', { model: 'glm-4.6v' });
    const vision = resolveProviderConfigForRole(settings, 'vision');
    expect(vision.error).toBeUndefined();
    expect(vision.config).toMatchObject({ providerId: 'zhipu', model: 'glm-4.6v' });
  });

  it('recognizes Zhipu embedding model ids', () => {
    let settings = createDefaultProviderSettings();
    settings = updateProviderConfig(settings, 'zhipu', { apiKey: 'sk-zhipu', model: 'embedding-3' });
    settings = assignModelRole(settings, 'embedding', 'zhipu');

    const resolution = resolveProviderConfigForRole(settings, 'embedding');

    expect(resolution.error).toBeUndefined();
    expect(resolution.config).toMatchObject({ providerId: 'zhipu', model: 'embedding-3' });
  });

  it('normalizes unknown or stale provider data', () => {
    const settings = normalizeProviderSettings({
      activeProviderId: 'ghost',
      configs: [{ providerId: 'openai', enabled: true, apiKey: 'sk-test' }],
      roleAssignments: { 'query-fast': 'ghost', vision: 'openai' },
    });

    expect(settings.activeProviderId).toBeNull();
    expect(settings.roleAssignments).toEqual({ vision: 'openai' });
    expect(settings.configs.find((config) => config.providerId === 'openai')?.apiKey).toBe('sk-test');
  });

  it('validates the active provider only', () => {
    const settings = activateProvider(createDefaultProviderSettings(), 'openai');
    expect(validateActiveProvider(settings)).toEqual(['API Key is required for enabled remote providers.']);
  });

  it('persists settings through a storage-like object', () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
    };

    const settings = activateProvider(createDefaultProviderSettings(), 'ollama');
    saveProviderSettings(settings, storage);

    expect(loadProviderSettings(storage).activeProviderId).toBe('ollama');
  });
});
