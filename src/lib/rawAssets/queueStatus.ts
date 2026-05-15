export type RawAssetQueueStage = 'idle' | 'running' | 'done' | 'failed';

export type RawAssetQueueSnapshot = {
  id: string;
  owner: string;
  stage: RawAssetQueueStage;
  percent: number;
  label: string;
  detail?: string;
  currentAssetId?: string;
  queuedAssetIds?: string[];
  total: number;
  processed: number;
  failed: number;
  startedAt: number;
  updatedAt: number;
};

export const RAW_ASSET_QUEUE_STATUS_KEY = 'mywiki.v2.rawAssetQueueStatus';
export const RAW_ASSET_QUEUE_EVENT = 'mywiki:raw-asset-queue-status';

const channelName = 'mywiki.rawAssetQueue';
const runningStaleMs = 45_000;

let channel: BroadcastChannel | null | undefined;

export function createRawAssetQueueRunId(owner: string) {
  return `${owner}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function loadRawAssetQueueStatus(): RawAssetQueueSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(RAW_ASSET_QUEUE_STATUS_KEY);
    if (!raw) return null;
    return normalizeQueueSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function publishRawAssetQueueStatus(snapshot: RawAssetQueueSnapshot) {
  if (typeof window === 'undefined') return;
  const normalized = normalizeQueueSnapshot(snapshot);
  window.localStorage.setItem(RAW_ASSET_QUEUE_STATUS_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent(RAW_ASSET_QUEUE_EVENT, { detail: normalized }));
  getChannel()?.postMessage(normalized);
}

export function subscribeRawAssetQueueStatus(listener: (snapshot: RawAssetQueueSnapshot | null) => void) {
  if (typeof window === 'undefined') return () => undefined;

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== RAW_ASSET_QUEUE_STATUS_KEY) return;
    listener(loadRawAssetQueueStatus());
  };
  const handleLocal = (event: Event) => {
    const detail = (event as CustomEvent<RawAssetQueueSnapshot>).detail;
    listener(normalizeQueueSnapshot(detail));
  };
  const handleMessage = (event: MessageEvent) => {
    listener(normalizeQueueSnapshot(event.data));
  };
  const broadcast = getChannel();

  window.addEventListener('storage', handleStorage);
  window.addEventListener(RAW_ASSET_QUEUE_EVENT, handleLocal);
  broadcast?.addEventListener('message', handleMessage);
  listener(loadRawAssetQueueStatus());

  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(RAW_ASSET_QUEUE_EVENT, handleLocal);
    broadcast?.removeEventListener('message', handleMessage);
  };
}

export function isRawAssetQueueRunning(snapshot: RawAssetQueueSnapshot | null = loadRawAssetQueueStatus()) {
  return Boolean(snapshot && snapshot.stage === 'running' && Date.now() - snapshot.updatedAt < runningStaleMs);
}

function normalizeQueueSnapshot(value: unknown): RawAssetQueueSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<RawAssetQueueSnapshot>;
  const stage = raw.stage === 'running' || raw.stage === 'done' || raw.stage === 'failed' ? raw.stage : 'idle';
  const now = Date.now();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createRawAssetQueueRunId('unknown'),
    owner: typeof raw.owner === 'string' && raw.owner ? raw.owner : 'unknown',
    stage,
    percent: clampNumber(raw.percent, 0, 100),
    label: typeof raw.label === 'string' ? raw.label : '',
    detail: typeof raw.detail === 'string' ? raw.detail : undefined,
    currentAssetId: typeof raw.currentAssetId === 'string' && raw.currentAssetId ? raw.currentAssetId : undefined,
    queuedAssetIds: Array.isArray(raw.queuedAssetIds)
      ? raw.queuedAssetIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
      : undefined,
    total: Math.max(0, Math.round(Number(raw.total) || 0)),
    processed: Math.max(0, Math.round(Number(raw.processed) || 0)),
    failed: Math.max(0, Math.round(Number(raw.failed) || 0)),
    startedAt: Number.isFinite(raw.startedAt) ? Number(raw.startedAt) : now,
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : now,
  };
}

function getChannel() {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return null;
  if (channel === undefined) {
    channel = new BroadcastChannel(channelName);
  }
  return channel;
}

function clampNumber(value: unknown, min: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.round(number)));
}
