export type WikiBatchCompileStage = 'idle' | 'running' | 'paused' | 'done' | 'failed';

export type WikiBatchCompileSnapshot = {
  id: string;
  owner: string;
  stage: WikiBatchCompileStage;
  percent: number;
  label: string;
  detail?: string;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  currentEntityId?: string;
  currentTitle?: string;
  startedAt: number;
  updatedAt: number;
};

export const WIKI_BATCH_COMPILE_STATUS_KEY = 'mywiki.v2.wikiBatchCompileStatus';
export const WIKI_BATCH_COMPILE_EVENT = 'mywiki:wiki-batch-compile-status';

const channelName = 'mywiki.wikiBatchCompile';
const runningStaleMs = 30 * 60 * 1000;

let channel: BroadcastChannel | null | undefined;

export function createWikiBatchCompileRunId(owner: string) {
  return `${owner}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function loadWikiBatchCompileStatus(): WikiBatchCompileSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(WIKI_BATCH_COMPILE_STATUS_KEY);
    if (!raw) return null;
    return normalizeWikiBatchCompileSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function publishWikiBatchCompileStatus(snapshot: WikiBatchCompileSnapshot) {
  if (typeof window === 'undefined') return;
  const normalized = normalizeWikiBatchCompileSnapshot(snapshot);
  if (!normalized) return;
  window.localStorage.setItem(WIKI_BATCH_COMPILE_STATUS_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent(WIKI_BATCH_COMPILE_EVENT, { detail: normalized }));
  getChannel()?.postMessage(normalized);
}

export function subscribeWikiBatchCompileStatus(listener: (snapshot: WikiBatchCompileSnapshot | null) => void) {
  if (typeof window === 'undefined') return () => undefined;

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== WIKI_BATCH_COMPILE_STATUS_KEY) return;
    listener(loadWikiBatchCompileStatus());
  };
  const handleLocal = (event: Event) => {
    const detail = (event as CustomEvent<WikiBatchCompileSnapshot>).detail;
    listener(normalizeWikiBatchCompileSnapshot(detail));
  };
  const handleMessage = (event: MessageEvent) => {
    listener(normalizeWikiBatchCompileSnapshot(event.data));
  };
  const broadcast = getChannel();

  window.addEventListener('storage', handleStorage);
  window.addEventListener(WIKI_BATCH_COMPILE_EVENT, handleLocal);
  broadcast?.addEventListener('message', handleMessage);
  listener(loadWikiBatchCompileStatus());

  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(WIKI_BATCH_COMPILE_EVENT, handleLocal);
    broadcast?.removeEventListener('message', handleMessage);
  };
}

export function isWikiBatchCompileRunning(snapshot: WikiBatchCompileSnapshot | null = loadWikiBatchCompileStatus()) {
  return Boolean(snapshot && snapshot.stage === 'running' && Date.now() - snapshot.updatedAt < runningStaleMs);
}

function normalizeWikiBatchCompileSnapshot(value: unknown): WikiBatchCompileSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<WikiBatchCompileSnapshot>;
  const stage: WikiBatchCompileStage =
    raw.stage === 'running' || raw.stage === 'paused' || raw.stage === 'done' || raw.stage === 'failed' || raw.stage === 'idle' ? raw.stage : 'idle';
  const now = Date.now();
  const total = countNumber(raw.total);
  const processed = countNumber(raw.processed, total || Number.MAX_SAFE_INTEGER);
  const succeeded = countNumber(raw.succeeded, processed || Number.MAX_SAFE_INTEGER);
  const failed = countNumber(raw.failed, processed || Number.MAX_SAFE_INTEGER);

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createWikiBatchCompileRunId('unknown'),
    owner: typeof raw.owner === 'string' && raw.owner ? raw.owner : 'unknown',
    stage,
    percent: clampNumber(raw.percent, 0, 100),
    label: typeof raw.label === 'string' ? raw.label : '',
    detail: typeof raw.detail === 'string' ? raw.detail : undefined,
    total,
    processed,
    succeeded,
    failed,
    currentEntityId: typeof raw.currentEntityId === 'string' ? raw.currentEntityId : undefined,
    currentTitle: typeof raw.currentTitle === 'string' ? raw.currentTitle : undefined,
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

function countNumber(value: unknown, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(max, Math.max(0, Math.round(number)));
}

function clampNumber(value: unknown, min: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.round(number)));
}
