import { Check, ChevronDown, ChevronUp, Clipboard, FileDown, Loader2, Minus, RotateCcw, Settings2 } from 'lucide-react';
import { type ClipboardEvent, type DragEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  createRawAssetFromFile,
  processRawAssetQueue,
  resetStaleRawAssets,
  subscribeRawAssetQueueStatus,
  type RawAssetQueueSnapshot,
} from '@/lib/rawAssets';
import { isSupportedImportFile } from '@/lib/import/fileText';
import { db } from '@/lib/db';
import type { RawAssetStatus } from '@/types';

type FrogMood = 'idle' | 'hover' | 'gulp' | 'digest' | 'done' | 'error';

type WidgetPosition = {
  x: number;
  y: number;
};

type ProgressState = {
  percent: number;
  label: string;
  detail?: string;
};

const statusLabel: Record<RawAssetStatus, string> = {
  raw: '待编译',
  extracting: '解析中',
  compiling: '编译中',
  compiled: '已入库',
  skipped: '已跳过',
  failed: '失败',
};

const FROG_POSITION_KEY = 'mywiki.froggy.position';

export function FrogWidgetPage() {
  const pageRef = useRef<HTMLElement | null>(null);
  const [mood, setMood] = useState<FrogMood>('idle');
  const [message, setMessage] = useState('把文件丢给我，我会先收进 Raw Inbox。');
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [queueStatus, setQueueStatus] = useState<RawAssetQueueSnapshot | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isDraggingWidget, setIsDraggingWidget] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [showIdleHint, setShowIdleHint] = useState(false);
  const [position, setPosition] = useState<WidgetPosition>(() => loadPosition());
  const rawAssets = useLiveQuery(() => db.rawAssets.orderBy('createdAt').reverse().limit(5).toArray(), [], []);
  const retryQueueKey = useMemo(
    () =>
      queueStatus?.stage === 'running'
        ? [queueStatus.currentAssetId ?? '', ...(queueStatus.queuedAssetIds ?? [])].join('|')
        : '',
    [queueStatus?.currentAssetId, queueStatus?.queuedAssetIds, queueStatus?.stage],
  );
  const rawAssetStats = useLiveQuery(
    async () => {
      const assets = await db.rawAssets.toArray();
      return assets.reduce(
        (stats, asset) => {
          const displayStatus = getDisplayRawAssetStatus(asset, queueStatus);
          stats.total += 1;
          if (displayStatus === 'raw' || displayStatus === 'extracting' || displayStatus === 'compiling') {
            stats.pending += 1;
          } else if (displayStatus === 'compiled') {
            stats.compiled += 1;
          } else if (displayStatus === 'failed') {
            stats.failed += 1;
          } else if (displayStatus === 'skipped') {
            stats.skipped += 1;
          }
          return stats;
        },
        { total: 0, pending: 0, compiled: 0, failed: 0, skipped: 0 },
      );
    },
    [retryQueueKey],
    { total: 0, pending: 0, compiled: 0, failed: 0, skipped: 0 },
  );
  const desktopShell = isTauriRuntime();

  useEffect(() => {
    pageRef.current?.focus();
    void resetStaleRawAssets();
  }, []);

  useEffect(
    () =>
      subscribeRawAssetQueueStatus((snapshot) => {
        setQueueStatus(snapshot);
        if (!snapshot) return;
        if (snapshot.stage === 'running') {
          setMood('digest');
          setIsBusy(true);
          setMessage(`${snapshot.owner === 'frog' ? '我正在' : '知识库页面正在'}消化材料。`);
          setProgress({
            percent: snapshot.percent,
            label: snapshot.label,
            detail: snapshot.detail,
          });
          return;
        }
        if (snapshot.owner !== 'frog' && Date.now() - snapshot.updatedAt < 5000) {
          setMood(snapshot.stage === 'failed' ? 'error' : 'done');
          setProgress({
            percent: snapshot.percent,
            label: snapshot.label,
            detail: snapshot.detail,
          });
          setMessage(snapshot.stage === 'failed' ? '知识库页面编译队列遇到失败。' : '知识库页面已完成编译队列。');
          finishLater(snapshot.stage === 'failed' ? 'error' : 'done');
        }
      }),
    [],
  );

  useEffect(() => {
    if (!desktopShell) return;
    const htmlBackground = document.documentElement.style.background;
    const bodyBackground = document.body.style.background;
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return () => {
      document.documentElement.style.background = htmlBackground;
      document.body.style.background = bodyBackground;
    };
  }, [desktopShell]);

  useEffect(() => {
    if (!desktopShell) return;
    const height = detailsOpen ? 610 : 360;
    void getCurrentWindow().setSize(new LogicalSize(340, height)).catch(() => undefined);
  }, [desktopShell, detailsOpen]);

  useEffect(() => {
    if (mood !== 'idle' || isBusy) {
      setShowIdleHint(false);
      return;
    }

    let active = true;
    let showTimer: number | undefined;
    let hideTimer: number | undefined;

    function schedule(delay: number) {
      showTimer = window.setTimeout(() => {
        if (!active) return;
        setShowIdleHint(true);
        hideTimer = window.setTimeout(() => {
          if (!active) return;
          setShowIdleHint(false);
          schedule(8000 + Math.random() * 12000);
        }, 3600);
      }, delay);
    }

    schedule(2400 + Math.random() * 4200);

    return () => {
      active = false;
      if (showTimer) window.clearTimeout(showTimer);
      if (hideTimer) window.clearTimeout(hideTimer);
    };
  }, [mood, isBusy]);

  useEffect(() => {
    localStorage.setItem(FROG_POSITION_KEY, JSON.stringify(position));
  }, [position]);

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (isBusy) return;
    setMood('hover');
    setMessage('松手，丢进嘴里。');
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    event.stopPropagation();
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    if (!isBusy) {
      setMood('idle');
      setMessage('把文件丢给我，我会先收进 Raw Inbox。');
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (isBusy) return;
    void ingestFiles(Array.from(event.dataTransfer.files));
  }

  function handlePaste(event: ClipboardEvent<HTMLElement>) {
    if (isBusy) return;
    const files = extractClipboardFiles(event.clipboardData);
    const text = event.clipboardData.getData('text/plain')?.trim();
    if (files.length === 0 && !text) return;
    event.preventDefault();
    const pastedItems = files.length > 0 ? files : [new File([text], `paste-${Date.now()}.md`, { type: 'text/markdown' })];
    void ingestFiles(pastedItems);
  }

  async function ingestFiles(files: File[]) {
    if (files.length === 0) return;

    setIsBusy(true);
    setMood('gulp');
    setProgress({ percent: 8, label: '接住材料', detail: `共 ${files.length} 个` });
    setMessage(files.length === 1 ? `吞下 ${files[0].name}` : `吞下 ${files.length} 个材料`);

    await wait(620);

    let accepted = 0;
    let reused = 0;
    const errors: string[] = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const percent = Math.max(12, Math.round(((index + 1) / files.length) * 48));
      if (!isSupportedImportFile(file.name, file.type)) {
        errors.push(`${file.name} 格式暂不支持`);
        setProgress({ percent, label: `跳过 ${file.name}`, detail: `${index + 1}/${files.length}` });
        continue;
      }

      try {
        const result = await createRawAssetFromFile(file);
        if (result.reused) reused += 1;
        else accepted += 1;
        setProgress({
          percent,
          label: result.reused ? `已存在 ${file.name}` : `已采集 ${file.name}`,
          detail: `${index + 1}/${files.length}`,
        });
      } catch (error) {
        errors.push(`${file.name}：${error instanceof Error ? error.message : '采集失败'}`);
      }
    }

    if (accepted + reused === 0) {
      setMood('error');
      setProgress({ percent: 100, label: '没有可接收材料', detail: errors.slice(0, 2).join('；') });
      setMessage(errors[0] ?? '这个格式暂时咽不下。');
      finishLater('error');
      return;
    }

    setMood('done');
    setProgress({
      percent: 100,
      label: '已采集到 Raw Inbox',
      detail: `新增 ${accepted} 个，已存在 ${reused} 个${errors.length > 0 ? `，跳过 ${errors.length} 个` : ''}`,
    });
    setMessage('已采集。需要时点开队列手动编译。');
    finishLater('done');
  }

  async function digestQueue(queuedCount: number, errorCount: number) {
    setMood('digest');
    setMessage('正在消化材料，AI 编译会在后台继续。');
    try {
      const result = await processRawAssetQueue({
        owner: 'frog',
        onStatus: (snapshot) => {
          setProgress({
            percent: snapshot.percent,
            label: snapshot.label,
            detail: snapshot.detail,
          });
        },
      });
      if (result.total === 0) {
        setMood('done');
        setProgress({ percent: 100, label: '已采集', detail: `新增/复用 ${queuedCount} 个` });
        setMessage('材料已在 Raw Inbox。');
        finishLater('done');
        return;
      }
      if (result.failed > 0) {
        setMood('error');
        setMessage(`已采集，但还有 ${result.failed} 个材料需要重试。`);
        setProgress({ percent: 100, label: '部分材料未编译成功', detail: errorCount > 0 ? `另有 ${errorCount} 个跳过` : undefined });
        finishLater('error');
        return;
      }
      setMood('done');
      setProgress({ percent: 100, label: '已入库', detail: `本轮处理 ${result.processed} 个材料` });
      setMessage('已入库。');
      finishLater('done');
    } catch (error) {
      setMood('error');
      setMessage(error instanceof Error ? error.message : '编译队列启动失败。');
      setProgress({ percent: 100, label: '编译队列未启动', detail: errorCount > 0 ? `另有 ${errorCount} 个跳过` : undefined });
      finishLater('error');
    }
  }

  function finishLater(finalMood: FrogMood) {
    window.setTimeout(() => {
      setIsBusy(false);
      setProgress(null);
      setMood('idle');
      setMessage(finalMood === 'error' ? '再丢一次，我会重试。' : '继续投喂新的材料。');
    }, 2600);
  }

  function handlePointerDown(event: PointerEvent<HTMLElement>) {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('[data-no-widget-drag],a,button,input,label,textarea,select')
    ) {
      return;
    }

    if (isTauriRuntime()) {
      void getCurrentWindow().startDragging().catch(() => undefined);
      return;
    }

    const startX = event.clientX;
    const startY = event.clientY;
    const startPosition = position;
    setIsDraggingWidget(true);
    event.currentTarget.setPointerCapture(event.pointerId);

    function move(nextEvent: globalThis.PointerEvent) {
      setPosition({
        x: clamp(startPosition.x + nextEvent.clientX - startX, 8, window.innerWidth - 340),
        y: clamp(startPosition.y + nextEvent.clientY - startY, 8, window.innerHeight - 360),
      });
    }

    function up() {
      setIsDraggingWidget(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function handleMinimize() {
    if (!desktopShell) return;
    void getCurrentWindow().minimize().catch(() => undefined);
  }

  const bubbleVisible = mood !== 'idle' || showIdleHint;
  const bubbleMessage = mood === 'idle' ? '我饿了，有文件可以喂给我' : message;
  const queueRunning = queueStatus?.stage === 'running';

  return (
    <main
      ref={pageRef}
      className="min-h-screen overflow-hidden bg-transparent text-[#17211b]"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
      tabIndex={0}
    >
      <section
        className={`frog-widget fixed w-[320px] rounded-[18px] ${mood === 'hover' ? 'frog-widget-hover' : ''} ${desktopShell ? 'border border-transparent bg-transparent p-2 shadow-none' : 'border border-[#d9e4d7] bg-[#fbfffb]/95 p-4 shadow-[0_20px_50px_rgb(31_41_55_/_0.16)] backdrop-blur'} ${isDraggingWidget ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{ left: position.x, top: position.y }}
        onPointerDown={handlePointerDown}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        aria-label="MyWiki 蛙蛙捕获入口"
      >
        <div className="absolute right-3 top-3 z-10 flex gap-1" data-no-widget-drag>
          <div className="hidden">
            <p className="text-xs font-medium text-[#155eef]">Froggy Capture</p>
            <h1 className="mt-1 text-base font-semibold">MyWiki 捕获蛙</h1>
          </div>
          {desktopShell ? (
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#d9e4d7] bg-white/90 text-[#4b5563] shadow-sm"
              title="最小化"
              aria-label="最小化"
              data-no-widget-drag
              onClick={handleMinimize}
            >
              <Minus size={15} />
            </button>
          ) : null}
          <a
            href="/capture"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#d9e4d7] bg-white/90 text-[#155eef] shadow-sm"
            title="打开捕获页"
            aria-label="打开捕获页"
          >
            <FileDown size={17} />
          </a>
        </div>

        <div className="frog-drop-zone pointer-events-none relative h-[220px] rounded-[18px] border border-dashed border-[#cfe1cf] bg-white/80 px-3 pb-4 pt-7 shadow-[0_16px_40px_rgb(31_41_55_/_0.10)] backdrop-blur">
          <div className="absolute inset-x-0 top-8">
            <FrogFace mood={mood} />
          </div>
          {bubbleVisible ? (
            <div className={`frog-bubble frog-bubble-floating ${mood === 'idle' ? 'frog-bubble-idle' : ''} ${mood === 'done' ? 'frog-bubble-done' : mood === 'error' ? 'frog-bubble-error' : ''}`}>
              {bubbleMessage}
            </div>
          ) : null}
          <p className="absolute inset-x-0 bottom-4 text-center text-xs text-[#65736a]">拖入文件 / 粘贴图片或文本</p>
        </div>

        <button
          type="button"
          className="mt-2 flex w-full items-center justify-between rounded-full border border-[#d9e4d7] bg-white/90 px-3 py-2 text-xs text-[#2f3f35] shadow-sm"
          data-no-widget-drag
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setDetailsOpen((open) => !open)}
          aria-expanded={detailsOpen}
        >
          <span className="inline-flex items-center gap-1.5">
            <Settings2 size={13} />
            {detailsOpen ? '收起消化状态' : isBusy ? '正在消化，点开查看' : '消化状态与队列'}
          </span>
          {detailsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        <div className={detailsOpen ? 'block' : 'hidden'} data-no-widget-drag onPointerDown={(event) => event.stopPropagation()}>
          <div className="mt-2 flex items-center justify-end rounded-[12px] border border-[#e2ebe1] bg-white/95 px-3 py-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full border border-[#d9e4d7] px-2 py-1 text-xs text-[#155eef] disabled:text-[#8a968e]"
            disabled={isBusy || queueRunning}
            onClick={() => {
              setMood('digest');
              setIsBusy(true);
              void digestQueue(0, 0);
            }}
          >
            {isBusy || queueRunning ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
            {queueRunning ? `编译中 ${queueStatus?.percent ?? 0}%` : '编译队列'}
          </button>
        </div>

        {progress ? <FrogProgress progress={progress} /> : null}

        <div className="mt-3 rounded-[12px] border border-[#e2ebe1] bg-white px-3 py-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="shrink-0 font-medium text-[#1f2937]">最近状态</span>
            <span className="shrink-0 text-[11px] text-[#65736a]">
              最近 {rawAssets?.length ?? 0} / 共 {rawAssetStats?.total ?? 0} 条
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-[#65736a]">
            <span>待编译/处理中 {rawAssetStats?.pending ?? 0}</span>
            <span>已入库 {rawAssetStats?.compiled ?? 0}</span>
            {(rawAssetStats?.skipped ?? 0) > 0 ? <span>已跳过 {rawAssetStats?.skipped ?? 0}</span> : null}
            {(rawAssetStats?.failed ?? 0) > 0 ? <span className="text-[#b42318]">失败 {rawAssetStats?.failed ?? 0}</span> : null}
          </div>
          {rawAssets && rawAssets.length > 0 ? (
            <div className="mt-2 space-y-1.5">
              {rawAssets.map((asset) => (
                <FrogRecentAsset key={asset.id} asset={asset} queueStatus={queueStatus} />
              ))}
              {(rawAssetStats?.total ?? 0) > rawAssets.length ? (
                <p className="px-1 text-[11px] text-[#7a827c]">
                  这里只显示最近 5 条，完整列表在捕获页 Raw Inbox。
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-2 text-xs text-[#65736a]">等待投喂。</p>
          )}
        </div>

        <div className="mt-3 grid gap-1.5 text-[11px] text-[#65736a]">
          <span className="inline-flex min-w-0 items-start gap-1 leading-5">
            <Clipboard size={12} />
            <span>支持文本、网页、表格、Word、PDF、图片</span>
          </span>
          <span className="inline-flex min-w-0 items-center gap-1 leading-5">
            <Settings2 size={12} />
            <span>位置已记忆</span>
          </span>
        </div>
        </div>
      </section>
    </main>
  );
}

function FrogFace({ mood }: { mood: FrogMood }) {
  return (
    <div className={`frog-face frog-${mood}`} aria-hidden="true">
      <svg viewBox="0 0 180 150" role="img">
        <ellipse className="frog-shadow" cx="90" cy="132" rx="58" ry="10" />
        <ellipse className="frog-body" cx="90" cy="86" rx="63" ry="47" />
        <circle className="frog-eye-base" cx="56" cy="48" r="24" />
        <circle className="frog-eye-base" cx="124" cy="48" r="24" />
        <circle className="frog-eye" cx="56" cy="50" r="12" />
        <circle className="frog-eye" cx="124" cy="50" r="12" />
        <circle className="frog-eye-light" cx="51" cy="45" r="4" />
        <circle className="frog-eye-light" cx="119" cy="45" r="4" />
        <path className="frog-belly" d="M54 91c11 31 61 31 72 0 1 23-14 43-36 43S53 114 54 91Z" />
        <path className="frog-mouth" d="M48 82c20 20 64 20 84 0" />
        <path className="frog-mouth-open" d="M47 80c15 32 72 32 86 0-9 35-78 35-86 0Z" />
        <circle className="frog-cheek" cx="44" cy="80" r="7" />
        <circle className="frog-cheek" cx="136" cy="80" r="7" />
        <path className="frog-arm frog-arm-left" d="M38 95c-14 5-22 14-22 25" />
        <path className="frog-arm frog-arm-right" d="M142 95c14 5 22 14 22 25" />
        {mood === 'done' ? <path className="frog-check" d="M75 105l11 10 22-27" /> : null}
        {mood === 'error' ? (
          <g className="frog-error-mark">
            <path d="M79 101l22 22M101 101l-22 22" />
          </g>
        ) : null}
      </svg>
    </div>
  );
}

function FrogRecentAsset({ asset, queueStatus }: { asset: { id: string; filename: string; status: RawAssetStatus; error?: string }; queueStatus: RawAssetQueueSnapshot | null }) {
  const displayStatus = getDisplayRawAssetStatus(asset, queueStatus);
  const showError = displayStatus === 'failed' && asset.error;

  return (
    <div
      className="rounded-[8px] bg-[#f7fbf7] px-2 py-1.5 text-xs text-[#65736a]"
      title={showError ? `${asset.filename}\n${asset.error}` : asset.filename}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <span className="min-w-0 truncate">{asset.filename}</span>
        <span
          className={[
            'shrink-0 rounded-full border px-2 py-0.5',
            displayStatus === 'failed' ? 'border-[#fecaca] bg-[#fff5f5] text-[#b42318]' : 'border-[#d9e4d7]',
          ].join(' ')}
        >
          {statusLabel[displayStatus]}
        </span>
      </div>
      {showError ? <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-[#b42318]">{asset.error}</p> : null}
    </div>
  );
}

function getDisplayRawAssetStatus(
  asset: { id: string; status: RawAssetStatus },
  queueStatus: RawAssetQueueSnapshot | null,
): RawAssetStatus {
  const isQueuedRetry =
    queueStatus?.stage === 'running' &&
    asset.status === 'failed' &&
    (queueStatus.currentAssetId === asset.id || Boolean(queueStatus.queuedAssetIds?.includes(asset.id)));
  return isQueuedRetry ? 'compiling' : asset.status;
}

function FrogProgress({ progress }: { progress: ProgressState }) {
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
  return (
    <div className="mt-3 rounded-[12px] border border-[#e2ebe1] bg-white px-3 py-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="inline-flex items-center gap-1 font-medium text-[#1f2937]">
          {percent >= 100 ? <Check size={13} /> : <Loader2 size={13} className="animate-spin" />}
          {progress.label}
        </span>
        <span className="tabular-nums text-[#155eef]">{percent}%</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#edf4ee]">
        <div className="h-full rounded-full bg-[#27a65b] transition-all duration-300" style={{ width: `${percent}%` }} />
      </div>
      {progress.detail ? <p className="mt-1 text-xs leading-4 text-[#65736a]">{progress.detail}</p> : null}
    </div>
  );
}

function hasDraggedFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes('Files');
}

function extractClipboardFiles(clipboardData: DataTransfer) {
  const files = Array.from(clipboardData.files ?? []);
  if (files.length > 0) return files.map(normalizeClipboardFile);
  return Array.from(clipboardData.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))
    .map(normalizeClipboardFile);
}

function normalizeClipboardFile(file: File, index: number) {
  if (file.name?.trim()) return file;
  return new File([file], `clipboard-${Date.now()}-${index}.${mimeExtension(file.type)}`, {
    type: file.type,
    lastModified: Date.now(),
  });
}

function mimeExtension(mimeType: string) {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('pdf')) return 'pdf';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'xlsx';
  if (mimeType.includes('csv')) return 'csv';
  if (mimeType.includes('tab-separated-values')) return 'tsv';
  if (mimeType.includes('html')) return 'html';
  if (mimeType.startsWith('text/')) return 'txt';
  return 'bin';
}

function loadPosition(): WidgetPosition {
  if (isTauriRuntime()) {
    return { x: 16, y: 16 };
  }

  try {
    const parsed = JSON.parse(localStorage.getItem(FROG_POSITION_KEY) ?? '') as WidgetPosition;
    if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
      return {
        x: clamp(parsed.x, 8, Math.max(8, window.innerWidth - 340)),
        y: clamp(parsed.y, 8, Math.max(8, window.innerHeight - 360)),
      };
    }
  } catch {
    // Ignore invalid saved positions.
  }
  return { x: Math.max(16, window.innerWidth - 360), y: Math.max(16, window.innerHeight - 390) };
}

function isTauriRuntime() {
  return typeof window !== 'undefined' && Reflect.has(window, '__TAURI_INTERNALS__');
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
