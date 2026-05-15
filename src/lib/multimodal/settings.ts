export type MultimodalSettings = {
  enabled: boolean;
  captionStandaloneImages: boolean;
  includeOcrText: boolean;
};

const storageKey = 'mywiki.v2.multimodalSettings';

export function createDefaultMultimodalSettings(): MultimodalSettings {
  return {
    enabled: true,
    captionStandaloneImages: true,
    includeOcrText: true,
  };
}

export function normalizeMultimodalSettings(input: unknown): MultimodalSettings {
  const defaults = createDefaultMultimodalSettings();
  if (!input || typeof input !== 'object') return defaults;
  const raw = input as Partial<MultimodalSettings>;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    captionStandaloneImages:
      typeof raw.captionStandaloneImages === 'boolean'
        ? raw.captionStandaloneImages
        : defaults.captionStandaloneImages,
    includeOcrText: typeof raw.includeOcrText === 'boolean' ? raw.includeOcrText : defaults.includeOcrText,
  };
}

export function loadMultimodalSettings(storage: Pick<Storage, 'getItem'> = window.localStorage) {
  const raw = storage.getItem(storageKey);
  if (!raw) return createDefaultMultimodalSettings();
  try {
    return normalizeMultimodalSettings(JSON.parse(raw));
  } catch {
    return createDefaultMultimodalSettings();
  }
}

export function saveMultimodalSettings(
  settings: MultimodalSettings,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
) {
  storage.setItem(storageKey, JSON.stringify(normalizeMultimodalSettings(settings), null, 2));
}
