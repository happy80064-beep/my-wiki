export type LlmApiMode =
  | 'openai-compatible'
  | 'anthropic-compatible'
  | 'gemini-native'
  | 'local-cli';

export type LlmProviderId =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'minimax-global'
  | 'minimax-cn'
  | 'moonshot'
  | 'zhipu'
  | 'groq'
  | 'xai'
  | 'nvidia'
  | 'ollama'
  | 'custom-openai'
  | 'custom-anthropic';

export type LlmProviderPreset = {
  id: LlmProviderId;
  label: string;
  description: string;
  defaultEndpoint: string;
  apiModeDefaultEndpoints?: Partial<Record<LlmApiMode, string>>;
  defaultApiMode: LlmApiMode;
  apiModes: LlmApiMode[];
  defaultModels: string[];
  requiresApiKey: boolean;
  supportsVision?: boolean;
  supportsEmbedding?: boolean;
};

export type ModelCapability = 'text' | 'vision' | 'embedding' | 'ocr';

export type LlmModelPreset = {
  id: string;
  label?: string;
  capabilities: ModelCapability[];
  recommendedFor?: ModelRoleId[];
  notes?: string;
};

export type ModelRoleId =
  | 'wiki-compile'
  | 'query-fast'
  | 'query-deep'
  | 'vision'
  | 'embedding'
  | 'review-lint';

export type ModelRolePreset = {
  id: ModelRoleId;
  label: string;
  description: string;
};

export type LlmProviderConfig = {
  providerId: LlmProviderId;
  enabled: boolean;
  apiMode: LlmApiMode;
  endpoint: string;
  apiKey: string;
  model: string;
  contextWindow: number;
};

export const ROLE_REQUIRED_CAPABILITIES: Record<ModelRoleId, ModelCapability[]> = {
  'wiki-compile': ['text'],
  'query-fast': ['text'],
  'query-deep': ['text'],
  vision: ['vision'],
  embedding: ['embedding'],
  'review-lint': ['text'],
};

export const LLM_MODEL_PRESETS: Partial<Record<LlmProviderId, LlmModelPreset[]>> = {
  openai: [
    { id: 'gpt-5.5', capabilities: ['text', 'vision'], recommendedFor: ['wiki-compile', 'query-deep', 'vision'] },
    { id: 'gpt-5.4', capabilities: ['text', 'vision'], recommendedFor: ['wiki-compile', 'query-deep', 'vision'] },
    { id: 'gpt-5.4-mini', capabilities: ['text', 'vision'], recommendedFor: ['query-fast', 'vision'] },
    { id: 'text-embedding-3-large', capabilities: ['embedding'], recommendedFor: ['embedding'] },
    { id: 'text-embedding-3-small', capabilities: ['embedding'], recommendedFor: ['embedding'] },
  ],
  anthropic: [
    { id: 'claude-sonnet-4.5', capabilities: ['text', 'vision'], recommendedFor: ['wiki-compile', 'query-deep', 'vision'] },
    { id: 'claude-haiku-4.5', capabilities: ['text', 'vision'], recommendedFor: ['query-fast', 'vision'] },
  ],
  gemini: [
    { id: 'gemini-2.5-pro', capabilities: ['text', 'vision'], recommendedFor: ['wiki-compile', 'query-deep', 'vision'] },
    { id: 'gemini-2.5-flash', capabilities: ['text', 'vision'], recommendedFor: ['query-fast', 'vision'] },
    { id: 'gemini-embedding-001', capabilities: ['embedding'], recommendedFor: ['embedding'] },
  ],
  deepseek: [
    { id: 'deepseek-v4-pro', capabilities: ['text'], recommendedFor: ['wiki-compile', 'query-deep', 'review-lint'] },
    { id: 'deepseek-chat', capabilities: ['text'], recommendedFor: ['query-fast', 'review-lint'] },
    { id: 'deepseek-reasoner', capabilities: ['text'], recommendedFor: ['query-deep', 'review-lint'] },
  ],
  'minimax-global': [
    {
      id: 'MiniMax-M2.7',
      capabilities: ['text'],
      recommendedFor: ['wiki-compile', 'query-fast', 'query-deep', 'review-lint'],
      notes: 'Token Plan 的图片理解目前走 MCP understand_image，不是普通文本 API 视觉输入。',
    },
    { id: 'MiniMax-M2.5', capabilities: ['text'], recommendedFor: ['query-fast', 'review-lint'] },
  ],
  'minimax-cn': [
    {
      id: 'MiniMax-M2.7',
      capabilities: ['text'],
      recommendedFor: ['wiki-compile', 'query-fast', 'query-deep', 'review-lint'],
      notes: 'Token Plan 的图片理解目前走 MCP understand_image，不是普通文本 API 视觉输入。',
    },
    { id: 'MiniMax-M2.5', capabilities: ['text'], recommendedFor: ['query-fast', 'review-lint'] },
  ],
  moonshot: [
    { id: 'kimi-k2', capabilities: ['text'], recommendedFor: ['wiki-compile', 'query-deep', 'review-lint'] },
    { id: 'moonshot-v1-128k', capabilities: ['text'], recommendedFor: ['wiki-compile', 'query-deep'] },
  ],
  zhipu: [
    { id: 'glm-4.6', capabilities: ['text'], recommendedFor: ['wiki-compile', 'query-deep', 'review-lint'] },
    { id: 'glm-4.5', capabilities: ['text'], recommendedFor: ['wiki-compile', 'query-deep', 'review-lint'] },
    { id: 'glm-5v-turbo', label: 'GLM-5V-Turbo', capabilities: ['text', 'vision'], recommendedFor: ['vision'] },
    { id: 'glm-4.6v', label: 'GLM-4.6V', capabilities: ['text', 'vision'], recommendedFor: ['vision'] },
    { id: 'glm-4.6v-flash', label: 'GLM-4.6V-Flash', capabilities: ['text', 'vision'], recommendedFor: ['vision'] },
    { id: 'glm-4.5v', label: 'GLM-4.5V', capabilities: ['text', 'vision'], recommendedFor: ['vision'] },
    { id: 'glm-4v-flash', label: 'GLM-4V-Flash', capabilities: ['text', 'vision'], recommendedFor: ['vision'] },
    { id: 'glm-ocr', label: 'GLM-OCR', capabilities: ['vision', 'ocr'], recommendedFor: ['vision'] },
    { id: 'embedding-3', label: 'Embedding-3', capabilities: ['embedding'], recommendedFor: ['embedding'] },
    { id: 'embedding-2', label: 'Embedding-2', capabilities: ['embedding'], recommendedFor: ['embedding'] },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', capabilities: ['text'], recommendedFor: ['query-fast', 'review-lint'] },
  ],
  xai: [
    { id: 'grok-4', capabilities: ['text', 'vision'], recommendedFor: ['query-deep', 'vision'] },
  ],
  nvidia: [
    { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', capabilities: ['text'], recommendedFor: ['query-deep'] },
  ],
  ollama: [
    { id: 'qwen3', capabilities: ['text'], recommendedFor: ['query-fast', 'review-lint'] },
    { id: 'llama3.3', capabilities: ['text'], recommendedFor: ['query-fast'] },
    { id: 'nomic-embed-text', capabilities: ['embedding'], recommendedFor: ['embedding'] },
    { id: 'mxbai-embed-large', capabilities: ['embedding'], recommendedFor: ['embedding'] },
    { id: 'llava', capabilities: ['text', 'vision'], recommendedFor: ['vision'] },
  ],
};

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'Official OpenAI API',
    defaultEndpoint: 'https://api.openai.com/v1',
    defaultApiMode: 'openai-compatible',
    apiModes: ['openai-compatible'],
    defaultModels: LLM_MODEL_PRESETS.openai?.map((model) => model.id) ?? [],
    requiresApiKey: true,
    supportsVision: true,
    supportsEmbedding: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    description: 'Official Anthropic Messages API',
    defaultEndpoint: 'https://api.anthropic.com',
    defaultApiMode: 'anthropic-compatible',
    apiModes: ['anthropic-compatible'],
    defaultModels: LLM_MODEL_PRESETS.anthropic?.map((model) => model.id) ?? [],
    requiresApiKey: true,
    supportsVision: true,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    description: 'Google Generative Language API',
    defaultEndpoint: 'https://generativelanguage.googleapis.com',
    defaultApiMode: 'gemini-native',
    apiModes: ['gemini-native'],
    defaultModels: LLM_MODEL_PRESETS.gemini?.map((model) => model.id) ?? [],
    requiresApiKey: true,
    supportsVision: true,
    supportsEmbedding: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'OpenAI-compatible DeepSeek API',
    defaultEndpoint: 'https://api.deepseek.com',
    defaultApiMode: 'openai-compatible',
    apiModes: ['openai-compatible'],
    defaultModels: LLM_MODEL_PRESETS.deepseek?.map((model) => model.id) ?? [],
    requiresApiKey: true,
  },
  {
    id: 'minimax-global',
    label: 'MiniMax Global',
    description: 'MiniMax global API',
    defaultEndpoint: 'https://api.minimax.io/v1',
    apiModeDefaultEndpoints: {
      'openai-compatible': 'https://api.minimax.io/v1',
      'anthropic-compatible': 'https://api.minimax.io/anthropic',
    },
    defaultApiMode: 'openai-compatible',
    apiModes: ['openai-compatible', 'anthropic-compatible'],
    defaultModels: LLM_MODEL_PRESETS['minimax-global']?.map((model) => model.id) ?? [],
    requiresApiKey: true,
  },
  {
    id: 'minimax-cn',
    label: 'MiniMax 中国',
    description: 'MiniMax China Anthropic-compatible API',
    defaultEndpoint: 'https://api.minimaxi.com/anthropic',
    apiModeDefaultEndpoints: {
      'anthropic-compatible': 'https://api.minimaxi.com/anthropic',
      'openai-compatible': 'https://api.minimaxi.com/v1',
    },
    defaultApiMode: 'anthropic-compatible',
    apiModes: ['anthropic-compatible', 'openai-compatible'],
    defaultModels: LLM_MODEL_PRESETS['minimax-cn']?.map((model) => model.id) ?? [],
    requiresApiKey: true,
  },
  {
    id: 'moonshot',
    label: 'Kimi / Moonshot',
    description: 'Moonshot OpenAI-compatible API',
    defaultEndpoint: 'https://api.moonshot.cn/v1',
    defaultApiMode: 'openai-compatible',
    apiModes: ['openai-compatible'],
    defaultModels: LLM_MODEL_PRESETS.moonshot?.map((model) => model.id) ?? [],
    requiresApiKey: true,
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    description: 'Zhipu OpenAI-compatible API',
    defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4',
    defaultApiMode: 'openai-compatible',
    apiModes: ['openai-compatible'],
    defaultModels: LLM_MODEL_PRESETS.zhipu?.map((model) => model.id) ?? [],
    requiresApiKey: true,
    supportsVision: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    description: 'Groq OpenAI-compatible API',
    defaultEndpoint: 'https://api.groq.com/openai/v1',
    defaultApiMode: 'openai-compatible',
    apiModes: ['openai-compatible'],
    defaultModels: LLM_MODEL_PRESETS.groq?.map((model) => model.id) ?? [],
    requiresApiKey: true,
  },
  {
    id: 'xai',
    label: 'xAI',
    description: 'xAI OpenAI-compatible API',
    defaultEndpoint: 'https://api.x.ai/v1',
    defaultApiMode: 'openai-compatible',
    apiModes: ['openai-compatible'],
    defaultModels: LLM_MODEL_PRESETS.xai?.map((model) => model.id) ?? [],
    requiresApiKey: true,
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    description: 'NVIDIA hosted inference API',
    defaultEndpoint: 'https://integrate.api.nvidia.com/v1',
    defaultApiMode: 'openai-compatible',
    apiModes: ['openai-compatible'],
    defaultModels: LLM_MODEL_PRESETS.nvidia?.map((model) => model.id) ?? [],
    requiresApiKey: true,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    description: 'Local OpenAI-compatible Ollama endpoint',
    defaultEndpoint: 'http://localhost:11434/v1',
    defaultApiMode: 'openai-compatible',
    apiModes: ['openai-compatible'],
    defaultModels: LLM_MODEL_PRESETS.ollama?.map((model) => model.id) ?? [],
    requiresApiKey: false,
  },
  {
    id: 'custom-openai',
    label: 'Custom OpenAI Compatible',
    description: 'Any OpenAI-compatible endpoint',
    defaultEndpoint: '',
    defaultApiMode: 'openai-compatible',
    apiModes: ['openai-compatible'],
    defaultModels: [],
    requiresApiKey: false,
    supportsVision: true,
    supportsEmbedding: true,
  },
  {
    id: 'custom-anthropic',
    label: 'Custom Anthropic Compatible',
    description: 'Any Anthropic-compatible endpoint',
    defaultEndpoint: '',
    defaultApiMode: 'anthropic-compatible',
    apiModes: ['anthropic-compatible'],
    defaultModels: [],
    requiresApiKey: false,
    supportsVision: true,
  },
];

export const DEFAULT_MODEL_ROLES: ModelRolePreset[] = [
  {
    id: 'wiki-compile',
    label: 'Wiki 编译模型',
    description: '负责两步摄入、Markdown 页面生成和结构化指标预编译。',
  },
  {
    id: 'query-fast',
    label: '查询快速答案模型',
    description: '负责低延迟快速答案或答案骨架。',
  },
  {
    id: 'query-deep',
    label: '查询深度表达模型',
    description: '负责读取完整上下文后的最终答案表达。',
  },
  {
    id: 'vision',
    label: '图片/多模态模型',
    description: '负责图片、截图、扫描件和低质量 PDF 页面的视觉理解。',
  },
  {
    id: 'embedding',
    label: 'Embedding 模型',
    description: '可选，用于后续语义搜索和相似页面召回。',
  },
  {
    id: 'review-lint',
    label: 'Review / Lint 模型',
    description: '负责审核建议、知识健康检查和自动消解判断。',
  },
];

export function getLlmProviderPreset(providerId: LlmProviderId) {
  return LLM_PROVIDER_PRESETS.find((provider) => provider.id === providerId);
}

export function getDefaultEndpointForApiMode(providerId: LlmProviderId, apiMode: LlmApiMode) {
  const preset = getLlmProviderPreset(providerId);
  return preset?.apiModeDefaultEndpoints?.[apiMode] ?? preset?.defaultEndpoint ?? '';
}

export function isKnownProviderEndpoint(providerId: LlmProviderId, endpoint: string) {
  const preset = getLlmProviderPreset(providerId);
  if (!preset) return false;
  const normalized = normalizeEndpoint(endpoint);
  const known = new Set([preset.defaultEndpoint, ...Object.values(preset.apiModeDefaultEndpoints ?? {})]);
  return [...known].some((value) => normalizeEndpoint(value) === normalized);
}

export function getProviderModelPresets(providerId: LlmProviderId) {
  return LLM_MODEL_PRESETS[providerId] ?? [];
}

export function getProviderModelPreset(providerId: LlmProviderId, modelId: string) {
  const normalized = normalizeModelId(modelId);
  return getProviderModelPresets(providerId).find((model) => normalizeModelId(model.id) === normalized);
}

export function modelHasCapability(providerId: LlmProviderId, modelId: string, capability: ModelCapability) {
  const model = getProviderModelPreset(providerId, modelId);
  if (!model) return undefined;
  return model.capabilities.includes(capability);
}

export function capabilityLabel(capability: ModelCapability) {
  return {
    text: '文本',
    vision: '视觉',
    embedding: 'Embedding',
    ocr: 'OCR',
  }[capability];
}

function normalizeModelId(modelId: string) {
  return modelId.trim().toLowerCase();
}

function normalizeEndpoint(endpoint: string) {
  return endpoint.trim().replace(/\/+$/, '').toLowerCase();
}

export function createDefaultProviderConfig(providerId: LlmProviderId): LlmProviderConfig {
  const preset = getLlmProviderPreset(providerId);
  if (!preset) throw new Error(`Unknown LLM provider: ${providerId}`);

  return {
    providerId,
    enabled: false,
    apiMode: preset.defaultApiMode,
    endpoint: preset.defaultEndpoint,
    apiKey: '',
    model: preset.defaultModels[0] ?? '',
    contextWindow: 200000,
  };
}

export function validateLlmProviderConfig(config: LlmProviderConfig) {
  const errors: string[] = [];
  const preset = getLlmProviderPreset(config.providerId);
  if (!preset) return [`Unknown provider: ${config.providerId}`];
  if (!config.enabled) return errors;

  if (!preset.apiModes.includes(config.apiMode)) {
    errors.push(`API mode ${config.apiMode} is not supported by ${preset.label}.`);
  }
  if (!config.endpoint.trim()) {
    errors.push('Endpoint is required for enabled providers.');
  }
  if (!config.model.trim()) {
    errors.push('Model is required for enabled providers.');
  }
  if (preset.requiresApiKey && !config.apiKey.trim()) {
    errors.push('API Key is required for enabled remote providers.');
  }
  if (!Number.isFinite(config.contextWindow) || config.contextWindow < 4000) {
    errors.push('Context window must be at least 4000 characters.');
  }

  return errors;
}
