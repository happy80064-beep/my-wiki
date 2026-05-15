import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_ROLES,
  getDefaultEndpointForApiMode,
  getProviderModelPreset,
  getLlmProviderPreset,
  isKnownProviderEndpoint,
  LLM_PROVIDER_PRESETS,
  validateLlmProviderConfig,
} from '@/lib/llm/providers';

describe('llm provider presets', () => {
  it('includes the provider families required by MyWiki v2', () => {
    expect(LLM_PROVIDER_PRESETS.map((provider) => provider.id)).toEqual([
      'openai',
      'anthropic',
      'gemini',
      'deepseek',
      'minimax-global',
      'minimax-cn',
      'moonshot',
      'zhipu',
      'groq',
      'xai',
      'nvidia',
      'ollama',
      'custom-openai',
      'custom-anthropic',
    ]);
  });

  it('keeps MiniMax China on the Anthropic-compatible endpoint by default', () => {
    expect(getLlmProviderPreset('minimax-cn')).toMatchObject({
      label: 'MiniMax 中国',
      defaultApiMode: 'anthropic-compatible',
      defaultEndpoint: 'https://api.minimaxi.com/anthropic',
    });
  });

  it('maps MiniMax endpoints to the selected API mode', () => {
    expect(getDefaultEndpointForApiMode('minimax-cn', 'anthropic-compatible')).toBe(
      'https://api.minimaxi.com/anthropic',
    );
    expect(getDefaultEndpointForApiMode('minimax-cn', 'openai-compatible')).toBe('https://api.minimaxi.com/v1');
    expect(getDefaultEndpointForApiMode('minimax-global', 'openai-compatible')).toBe('https://api.minimax.io/v1');
    expect(getDefaultEndpointForApiMode('minimax-global', 'anthropic-compatible')).toBe(
      'https://api.minimax.io/anthropic',
    );
  });

  it('recognizes provider default endpoints without matching custom proxy endpoints', () => {
    expect(isKnownProviderEndpoint('minimax-cn', 'https://api.minimaxi.com/v1/')).toBe(true);
    expect(isKnownProviderEndpoint('minimax-cn', 'https://proxy.example.com/minimax')).toBe(false);
  });

  it('defines separate model roles for compile, query, vision and embedding', () => {
    expect(DEFAULT_MODEL_ROLES.map((role) => role.id)).toEqual([
      'wiki-compile',
      'query-fast',
      'query-deep',
      'vision',
      'embedding',
      'review-lint',
    ]);
  });

  it('includes current Zhipu vision, OCR and embedding model capabilities', () => {
    expect(getProviderModelPreset('zhipu', 'glm-4.6v')?.capabilities).toEqual(['text', 'vision']);
    expect(getProviderModelPreset('zhipu', 'glm-5v-turbo')?.capabilities).toEqual(['text', 'vision']);
    expect(getProviderModelPreset('zhipu', 'glm-4.6v-flash')?.capabilities).toEqual(['text', 'vision']);
    expect(getProviderModelPreset('zhipu', 'glm-ocr')?.capabilities).toEqual(['vision', 'ocr']);
    expect(getProviderModelPreset('zhipu', 'embedding-3')?.capabilities).toEqual(['embedding']);
  });

  it('validates enabled remote provider config', () => {
    expect(
      validateLlmProviderConfig({
        providerId: 'openai',
        enabled: true,
        apiMode: 'openai-compatible',
        endpoint: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-5.5',
        contextWindow: 200000,
      }),
    ).toEqual(['API Key is required for enabled remote providers.']);

    expect(
      validateLlmProviderConfig({
        providerId: 'openai',
        enabled: true,
        apiMode: 'openai-compatible',
        endpoint: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-5.5',
        contextWindow: 200000,
      }),
    ).toEqual([]);
  });

  it('allows local Ollama without an API key', () => {
    expect(
      validateLlmProviderConfig({
        providerId: 'ollama',
        enabled: true,
        apiMode: 'openai-compatible',
        endpoint: 'http://localhost:11434/v1',
        apiKey: '',
        model: 'qwen3',
        contextWindow: 32000,
      }),
    ).toEqual([]);
  });
});
