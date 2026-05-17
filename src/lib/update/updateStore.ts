import { create } from 'zustand';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import type { UpdateStatus } from './updateCheck';

export type PersistedUpdateCheckState = {
  enabled: boolean;
  lastCheckedAt: number | null;
  dismissedVersion: string | null;
};

export interface UpdateStoreState extends PersistedUpdateCheckState {
  checking: boolean;
  lastResult: UpdateStatus | null;
  setChecking: (checking: boolean) => void;
  setResult: (result: UpdateStatus, checkedAt: number) => void;
  setDismissed: (version: string | null) => void;
  setEnabled: (enabled: boolean) => void;
  hydrate: (state: Partial<PersistedUpdateCheckState>) => void;
}

const updateCheckStorageKey = 'mywiki.v2.updateCheckState';
const productionUpdateCheckStorageKey = 'mywiki.v2.production.updateCheckState';

export const defaultUpdateCheckState: PersistedUpdateCheckState = {
  enabled: true,
  lastCheckedAt: null,
  dismissedVersion: null,
};

export const useUpdateStore = create<UpdateStoreState>((set) => ({
  ...defaultUpdateCheckState,
  checking: false,
  lastResult: null,
  setChecking: (checking) => set({ checking }),
  setResult: (lastResult, lastCheckedAt) => set({ lastResult, lastCheckedAt, checking: false }),
  setDismissed: (dismissedVersion) => set({ dismissedVersion }),
  setEnabled: (enabled) => set({ enabled }),
  hydrate: (state) => set(normalizePersistedUpdateState(state)),
}));

export function hasAvailableUpdate(state: Pick<UpdateStoreState, 'lastResult'>): boolean {
  return state.lastResult?.kind === 'available';
}

export function shouldShowUpdateBanner(
  state: Pick<UpdateStoreState, 'lastResult' | 'dismissedVersion'>,
): boolean {
  if (state.lastResult?.kind !== 'available') return false;
  return state.dismissedVersion !== state.lastResult.remote;
}

export function loadUpdateCheckState(storage: Pick<Storage, 'getItem'> | null = getStorage()): PersistedUpdateCheckState {
  if (!storage) return defaultUpdateCheckState;
  const raw = storage.getItem(getUpdateCheckStorageKey());
  if (!raw) return defaultUpdateCheckState;
  try {
    return normalizePersistedUpdateState(JSON.parse(raw));
  } catch {
    return defaultUpdateCheckState;
  }
}

export function saveUpdateCheckState(
  state: PersistedUpdateCheckState,
  storage: Pick<Storage, 'setItem'> | null = getStorage(),
) {
  if (!storage) return;
  storage.setItem(getUpdateCheckStorageKey(), JSON.stringify(normalizePersistedUpdateState(state), null, 2));
}

export function getUpdateCheckStorageKey() {
  return !import.meta.env.DEV && isTauriRuntime() ? productionUpdateCheckStorageKey : updateCheckStorageKey;
}

export function normalizePersistedUpdateState(input: unknown): PersistedUpdateCheckState {
  if (!isObject(input)) return defaultUpdateCheckState;
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
    lastCheckedAt: typeof input.lastCheckedAt === 'number' && Number.isFinite(input.lastCheckedAt) ? input.lastCheckedAt : null,
    dismissedVersion: typeof input.dismissedVersion === 'string' && input.dismissedVersion.trim() ? input.dismissedVersion : null,
  };
}

function getStorage() {
  return typeof window === 'undefined' ? null : window.localStorage;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
