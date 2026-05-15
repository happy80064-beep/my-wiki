import { createId, db, getClientId } from '@/lib/db';
import type { WikiBatchJob, WikiBatchJobItem, WikiBatchJobStatus } from '@/types';
import {
  isWikiBatchCompileRunning,
  loadWikiBatchCompileStatus,
  publishWikiBatchCompileStatus,
  type WikiBatchCompileSnapshot,
} from './batchCompileStatus';
import { recompileBrowserEntityWikiPage } from './browserRecompile';

export type BrowserWikiBatchCandidate = {
  id: string;
  title: string;
};

export type BrowserWikiBatchRecompileResult = {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  status: WikiBatchJobStatus;
};

const maxAttempts = 3;
const itemTimeoutMs = 5 * 60 * 1000;
const retryDelayMs = 1500;
const recoverableStatuses = new Set<WikiBatchJobStatus>(['pending', 'running', 'paused']);

let activeRun: Promise<BrowserWikiBatchRecompileResult> | null = null;
let activeJobId: string | null = null;

export function getBrowserWikiBatchRecompilePromise() {
  return activeRun;
}

export function isBrowserWikiBatchRecompileActive() {
  return Boolean(activeRun);
}

export async function getLatestRecoverableWikiBatchJob(): Promise<WikiBatchJob | null> {
  const job = await db.wikiBatchJobs
    .orderBy('updatedAt')
    .reverse()
    .filter((candidate) => isRecoverableJob(candidate))
    .first();
  return job ?? null;
}

export async function reconcileInterruptedWikiBatchRun() {
  if (activeRun) return;

  const snapshot = loadWikiBatchCompileStatus();
  if (snapshot?.stage !== 'running') return;

  const job = await db.wikiBatchJobs.get(snapshot.id).catch(() => undefined);
  if (!job) {
    publishWikiBatchCompileStatus({
      ...snapshot,
      stage: 'paused',
      label: '旧版批量生成任务已暂停',
      detail: '刷新前启动的任务没有明细记录；点击继续时会按当前知识树顺序从已处理进度后恢复。',
      updatedAt: Date.now(),
    });
    return;
  }
  if (shouldFinalizeJob(job)) {
    const completed = await finalizeJob(job.id);
    publishJobStatus(completed);
    return;
  }
  if (!isRecoverableJob(job)) return;

  const paused = await updateJob(job.id, (draft) => {
    draft.status = 'paused';
    draft.error = '页面刷新、浏览器重启或任务运行上下文丢失，可点击继续。';
    draft.currentEntityId = draft.currentEntityId ?? snapshot.currentEntityId;
    draft.currentTitle = draft.currentTitle ?? snapshot.currentTitle;
  });
  publishJobStatus(paused);
}

export async function recoverLegacyWikiBatchJob(
  candidates: BrowserWikiBatchCandidate[],
  options: { owner?: string } = {},
) {
  const snapshot = loadWikiBatchCompileStatus();
  if (!snapshot || (snapshot.stage !== 'running' && snapshot.stage !== 'paused')) return null;
  const existing = await db.wikiBatchJobs.get(snapshot.id).catch(() => undefined);
  if (existing) return existing;

  const seen = new Set<string>();
  const runnableCandidates = candidates.filter((candidate) => {
    if (!candidate.id || seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
  if (!runnableCandidates.length) return null;

  const succeeded = Math.min(snapshot.succeeded, runnableCandidates.length);
  const failed = Math.min(snapshot.failed, Math.max(0, runnableCandidates.length - succeeded));
  const processed = Math.min(Math.max(snapshot.processed, succeeded + failed), runnableCandidates.length);
  const inferredSucceeded = Math.max(0, processed - failed);
  const now = Date.now();
  const items = runnableCandidates.map((candidate, index): WikiBatchJobItem => {
    const status: WikiBatchJobItem['status'] = index < inferredSucceeded ? 'done' : index < processed ? 'failed' : 'pending';
    return {
      entityId: candidate.id,
      title: candidate.title,
      status,
      attempts: status === 'pending' ? 0 : 1,
      error: status === 'failed' ? '旧版批量任务中已记录为失败。' : undefined,
      startedAt: status === 'pending' ? undefined : snapshot.startedAt,
      updatedAt: status === 'pending' ? undefined : snapshot.updatedAt,
      completedAt: status === 'pending' ? undefined : snapshot.updatedAt,
    };
  });

  const job: WikiBatchJob = {
    id: snapshot.id,
    clientId: getClientId(),
    owner: options.owner ?? snapshot.owner ?? 'wiki',
    status: processed >= runnableCandidates.length ? (failed > 0 ? 'failed' : 'done') : 'paused',
    items,
    total: runnableCandidates.length,
    processed,
    succeeded: inferredSucceeded,
    failed,
    currentEntityId: snapshot.currentEntityId,
    currentTitle: snapshot.currentTitle,
    error: '已从刷新前的旧版批量状态转换，可继续运行。',
    createdAt: snapshot.startedAt,
    updatedAt: now,
    startedAt: snapshot.startedAt,
    completedAt: processed >= runnableCandidates.length ? now : undefined,
  };
  await db.wikiBatchJobs.put(job);
  publishJobStatus(job);
  return job;
}

export async function startBrowserWikiBatchRecompile(
  candidates: BrowserWikiBatchCandidate[],
  options: { owner?: string } = {},
): Promise<BrowserWikiBatchRecompileResult> {
  if (activeRun) return activeRun;

  await reconcileInterruptedWikiBatchRun();
  const activeSnapshot = loadWikiBatchCompileStatus();
  if (isWikiBatchCompileRunning(activeSnapshot)) {
    throw new Error('Wiki 页面正在批量生成/更新中，请等待当前任务完成。');
  }

  const existing = await getLatestRecoverableWikiBatchJob();
  if (existing) {
    throw new Error('发现一个未完成的 Wiki 批量任务，请先继续或完成它，避免重复消耗 token。');
  }

  const job = await createWikiBatchJob(candidates, options.owner ?? 'wiki');
  return resumeBrowserWikiBatchRecompile(job.id);
}

export function resumeBrowserWikiBatchRecompile(jobId: string): Promise<BrowserWikiBatchRecompileResult> {
  if (activeRun) {
    if (!activeJobId || activeJobId === jobId) return activeRun;
    return Promise.reject(new Error('已有另一个 Wiki 批量任务正在运行，请等待它完成。'));
  }

  activeJobId = jobId;
  const run = runBrowserWikiBatchJob(jobId).finally(() => {
    if (activeRun === run) {
      activeRun = null;
      activeJobId = null;
    }
  });
  activeRun = run;
  return run;
}

async function createWikiBatchJob(candidates: BrowserWikiBatchCandidate[], owner: string) {
  const seen = new Set<string>();
  const items = candidates
    .filter((candidate) => {
      if (!candidate.id || seen.has(candidate.id)) return false;
      seen.add(candidate.id);
      return true;
    })
    .map(
      (candidate): WikiBatchJobItem => ({
        entityId: candidate.id,
        title: candidate.title,
        status: 'pending',
        attempts: 0,
      }),
    );

  const now = Date.now();
  const job: WikiBatchJob = {
    id: createId('wiki_batch'),
    clientId: getClientId(),
    owner,
    status: items.length ? 'pending' : 'done',
    items,
    total: items.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: items.length ? undefined : now,
  };
  await db.wikiBatchJobs.put(job);
  publishJobStatus(job);
  return job;
}

async function runBrowserWikiBatchJob(jobId: string): Promise<BrowserWikiBatchRecompileResult> {
  let job = await updateJob(jobId, (draft) => {
    draft.status = draft.total ? 'running' : 'done';
    draft.startedAt ??= Date.now();
    draft.error = undefined;
  });
  publishJobStatus(job);

  while (true) {
    job = await getRequiredJob(jobId);
    if (!recoverableStatuses.has(job.status)) return toResult(job);

    const nextIndex = job.items.findIndex((item) => item.status === 'pending' || item.status === 'running');
    if (nextIndex < 0) {
      const completed = await finalizeJob(jobId);
      publishJobStatus(completed);
      return toResult(completed);
    }

    if (isBrowserOffline()) {
      const paused = await pauseJob(jobId, '网络当前不可用，任务已暂停；恢复网络后可点击继续。');
      publishJobStatus(paused);
      return toResult(paused);
    }

    const nextItem = job.items[nextIndex];
    job = await updateJob(jobId, (draft) => {
      const item = draft.items[nextIndex];
      item.status = 'running';
      item.attempts += 1;
      item.error = undefined;
      item.startedAt ??= Date.now();
      item.updatedAt = Date.now();
      draft.status = 'running';
      draft.currentEntityId = item.entityId;
      draft.currentTitle = item.title;
      draft.error = undefined;
    });
    publishJobStatus(job);

    const runningItem = job.items[nextIndex];
    try {
      await recompileWithTimeout(runningItem.entityId);
      job = await updateJob(jobId, (draft) => {
        const item = draft.items[nextIndex];
        item.status = 'done';
        item.error = undefined;
        item.updatedAt = Date.now();
        item.completedAt = Date.now();
        recalculateJobProgress(draft);
      });
      publishJobStatus(job, `已完成《${runningItem.title}》`);
    } catch (error) {
      const message = normalizeErrorMessage(error);
      if (isBrowserOffline()) {
        const paused = await updateJob(jobId, (draft) => {
          const item = draft.items[nextIndex];
          item.status = 'pending';
          item.error = message;
          item.updatedAt = Date.now();
          recalculateJobProgress(draft);
          draft.status = 'paused';
          draft.error = `网络中断，已暂停在《${item.title}》。`;
        });
        publishJobStatus(paused);
        return toResult(paused);
      }

      if (runningItem.attempts < maxAttempts) {
        const retrying = await updateJob(jobId, (draft) => {
          const item = draft.items[nextIndex];
          item.status = 'pending';
          item.error = `${message}；准备第 ${item.attempts + 1}/${maxAttempts} 次尝试。`;
          item.updatedAt = Date.now();
          draft.status = 'running';
          draft.error = item.error;
          recalculateJobProgress(draft);
        });
        publishJobStatus(retrying, `《${runningItem.title}》生成/更新失败，准备重试`, retrying.error);
        await sleep(retryDelayMs);
        continue;
      }

      job = await updateJob(jobId, (draft) => {
        const item = draft.items[nextIndex];
        item.status = 'failed';
        item.error = message;
        item.updatedAt = Date.now();
        item.completedAt = Date.now();
        recalculateJobProgress(draft);
        draft.status = 'running';
        draft.error = message;
      });
      publishJobStatus(job, `《${runningItem.title}》生成/更新失败`, message);
    }
  }
}

async function recompileWithTimeout(entityId: string) {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  let timeout: number | undefined;
  if (controller) {
    timeout = window.setTimeout(() => controller.abort(), itemTimeoutMs);
  }
  try {
    await recompileBrowserEntityWikiPage(entityId, controller ? { signal: controller.signal } : undefined);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

async function pauseJob(jobId: string, reason: string) {
  return updateJob(jobId, (draft) => {
    draft.status = 'paused';
    draft.error = reason;
    for (const item of draft.items) {
      if (item.status === 'running') {
        item.status = 'pending';
        item.error = reason;
        item.updatedAt = Date.now();
      }
    }
    recalculateJobProgress(draft);
  });
}

async function finalizeJob(jobId: string) {
  return updateJob(jobId, (draft) => {
    const summary = summarizeItems(draft.items);
    draft.processed = summary.processed;
    draft.succeeded = summary.succeeded;
    draft.failed = summary.failed;
    draft.status = summary.failed > 0 ? 'failed' : 'done';
    draft.currentEntityId = undefined;
    draft.currentTitle = undefined;
    draft.error = summary.failed > 0 ? `${summary.failed} 个词条生成/更新失败。` : undefined;
    draft.completedAt = Date.now();
  });
}

async function updateJob(jobId: string, updater: (job: WikiBatchJob) => void) {
  const job = await getRequiredJob(jobId);
  const draft: WikiBatchJob = {
    ...job,
    items: job.items.map((item) => ({ ...item })),
    updatedAt: Date.now(),
  };
  updater(draft);
  draft.updatedAt = Date.now();
  await db.wikiBatchJobs.put(draft);
  return draft;
}

async function getRequiredJob(jobId: string) {
  const job = await db.wikiBatchJobs.get(jobId);
  if (!job) throw new Error('未找到 Wiki 批量任务记录。');
  return job;
}

function publishJobStatus(job: WikiBatchJob, labelOverride?: string, detailOverride?: string) {
  const label = labelOverride ?? buildJobLabel(job);
  const detail = detailOverride ?? buildJobDetail(job);
  const snapshot: WikiBatchCompileSnapshot = {
    id: job.id,
    owner: job.owner,
    stage: mapJobStatusToStage(job.status),
    percent: calculatePercent(job),
    label,
    detail,
    total: job.total,
    processed: job.processed,
    succeeded: job.succeeded,
    failed: job.failed,
    currentEntityId: job.currentEntityId,
    currentTitle: job.currentTitle,
    startedAt: job.startedAt ?? job.createdAt,
    updatedAt: job.updatedAt,
  };
  publishWikiBatchCompileStatus(snapshot);
}

function buildJobLabel(job: WikiBatchJob) {
  if (job.status === 'paused') return '批量生成/更新已暂停，可点击继续';
  if (job.status === 'done') return '批量生成/更新完成';
  if (job.status === 'failed') return `批量生成/更新完成，但有 ${job.failed} 个失败`;
  const ordinal = Math.min(job.processed + 1, Math.max(job.total, 1));
  return `正在生成/更新 Wiki 页面 ${ordinal}/${job.total}`;
}

function buildJobDetail(job: WikiBatchJob) {
  if (job.status === 'paused') return job.error;
  if (job.status === 'done' || job.status === 'failed') {
    return `成功 ${job.succeeded}/${job.total}${job.failed > 0 ? `，失败 ${job.failed} 个` : ''}`;
  }
  const attempt = job.items.find((item) => item.entityId === job.currentEntityId)?.attempts;
  return [job.currentTitle, attempt && attempt > 1 ? `第 ${attempt}/${maxAttempts} 次尝试` : undefined, job.error]
    .filter(Boolean)
    .join('；');
}

function mapJobStatusToStage(status: WikiBatchJobStatus): WikiBatchCompileSnapshot['stage'] {
  if (status === 'running' || status === 'pending') return 'running';
  if (status === 'paused' || status === 'cancelled') return 'paused';
  if (status === 'failed') return 'failed';
  return 'done';
}

function calculatePercent(job: WikiBatchJob) {
  if (job.total === 0) return 100;
  if (job.status === 'done' || job.status === 'failed') return 100;
  return Math.min(99, Math.max(1, Math.round((job.processed / job.total) * 100)));
}

function recalculateJobProgress(job: WikiBatchJob) {
  const summary = summarizeItems(job.items);
  job.processed = summary.processed;
  job.succeeded = summary.succeeded;
  job.failed = summary.failed;
}

function summarizeItems(items: WikiBatchJobItem[]) {
  const succeeded = items.filter((item) => item.status === 'done').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  return {
    processed: succeeded + failed,
    succeeded,
    failed,
  };
}

function isRecoverableJob(job: WikiBatchJob) {
  return recoverableStatuses.has(job.status) && job.items.some((item) => item.status === 'pending' || item.status === 'running');
}

function shouldFinalizeJob(job: WikiBatchJob) {
  return recoverableStatuses.has(job.status) && job.items.length > 0 && !job.items.some((item) => item.status === 'pending' || item.status === 'running');
}

function toResult(job: WikiBatchJob): BrowserWikiBatchRecompileResult {
  return {
    total: job.total,
    processed: job.processed,
    succeeded: job.succeeded,
    failed: job.failed,
    status: job.status,
  };
}

function normalizeErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') return '请求超时，已停止等待当前词条。';
  if (error instanceof Error) return error.message || '未知错误';
  return '未知错误';
}

function isBrowserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
