import { isTauriRuntime } from '@/lib/runtime/tauri';

export type SearchProvider = 'none' | 'tavily';

export type ResearchSettings = {
  provider: SearchProvider;
  apiKey: string;
  maxResults: number;
};

const storageKey = 'mywiki.v2.researchSettings';
const productionTauriStorageKey = 'mywiki.v2.production.researchSettings';

export function createDefaultResearchSettings(): ResearchSettings {
  return {
    provider: 'none',
    apiKey: '',
    maxResults: 5,
  };
}

export function normalizeResearchSettings(input: unknown): ResearchSettings {
  const defaults = createDefaultResearchSettings();
  if (!input || typeof input !== 'object') return defaults;
  const raw = input as Partial<ResearchSettings>;
  return {
    provider: raw.provider === 'tavily' ? 'tavily' : 'none',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    maxResults: clampInt(raw.maxResults, 1, 10, defaults.maxResults),
  };
}

export function loadResearchSettings(storage: Pick<Storage, 'getItem'> = window.localStorage) {
  const raw = storage.getItem(getResearchSettingsStorageKey());
  if (!raw) return createDefaultResearchSettings();
  try {
    return normalizeResearchSettings(JSON.parse(raw));
  } catch {
    return createDefaultResearchSettings();
  }
}

export function saveResearchSettings(
  settings: ResearchSettings,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
) {
  storage.setItem(getResearchSettingsStorageKey(), JSON.stringify(normalizeResearchSettings(settings), null, 2));
}

export function getResearchSettingsStorageKey() {
  return !import.meta.env.DEV && isTauriRuntime() ? productionTauriStorageKey : storageKey;
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}
