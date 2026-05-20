import { Check, ChevronDown, ChevronUp, Clipboard, FileDown, Loader2, Minus, RotateCcw, Settings2 } from 'lucide-react';
import { type ClipboardEvent, type DragEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  createRawAssetFromFile,
  createRawAssetFromUrl,
  processRawAssetQueue,
  resetStaleRawAssets,
  subscribeRawAssetQueueStatus,
  type RawAssetQueueSnapshot,
} from '@/lib/rawAssets';
import { isSupportedImportFile } from '@/lib/import/fileText';
import { extractHttpUrlsFromText } from '@/lib/import/webUrl';
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
  cancelled: '已取消',
  wiki_compiling: '生成 Wiki 中',
  wiki_failed: 'Wiki 失败',
};

const FROG_POSITION_KEY = 'mywiki.froggy.position';
const BROWSER_WIDGET_WIDTH = 340;
const BROWSER_WIDGET_HEIGHT = 360;
const DESKTOP_WIDGET_WIDTH = 150;
const DESKTOP_WIDGET_HEIGHT = 172;
const DESKTOP_WIDGET_DETAILS_HEIGHT = 350;

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
          if (displayStatus === 'raw' || displayStatus === 'extracting' || displayStatus === 'compiling' || displayStatus === 'wiki_compiling') {
            stats.pending += 1;
          } else if (displayStatus === 'compiled') {
            stats.compiled += 1;
          } else if (displayStatus === 'failed' || displayStatus === 'wiki_failed') {
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
    const height = detailsOpen ? DESKTOP_WIDGET_DETAILS_HEIGHT : DESKTOP_WIDGET_HEIGHT;
    void getCurrentWindow().setSize(new LogicalSize(DESKTOP_WIDGET_WIDTH, height)).catch(() => undefined);
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
    if (files.length > 0) {
      void ingestFiles(files);
      return;
    }
    const urls = extractHttpUrlsFromText(text ?? '');
    if (urls.length > 0) {
      void ingestUrls(urls);
      return;
    }
    void ingestFiles([new File([text], `paste-${Date.now()}.md`, { type: 'text/markdown' })]);
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

  async function ingestUrls(urls: string[]) {
    if (urls.length === 0) return;

    setIsBusy(true);
    setMood('gulp');
    setProgress({ percent: 8, label: '抓取网页', detail: `共 ${urls.length} 个链接` });
    setMessage(urls.length === 1 ? '正在抓取网页正文' : `正在抓取 ${urls.length} 个网页`);

    await wait(320);

    let accepted = 0;
    let reused = 0;
    const errors: string[] = [];

    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index];
      const percent = Math.max(12, Math.round(((index + 1) / urls.length) * 72));
      try {
        const result = await createRawAssetFromUrl(url);
        if (result.reused) reused += 1;
        else accepted += 1;
        setProgress({
          percent,
          label: result.reused ? '网页已存在' : '网页已抓取',
          detail: `${index + 1}/${urls.length}`,
        });
      } catch (error) {
        errors.push(`${url}：${error instanceof Error ? error.message : '网页抓取失败'}`);
        setProgress({ percent, label: '网页抓取失败', detail: `${index + 1}/${urls.length}` });
      }
    }

    if (accepted + reused === 0) {
      setMood('error');
      setProgress({ percent: 100, label: '没有抓取到网页正文', detail: errors.slice(0, 2).join('；') });
      setMessage(errors[0] ?? '网页抓取失败。');
      finishLater('error');
      return;
    }

    setMood('done');
    setProgress({
      percent: 100,
      label: '网页已采集到 Raw Inbox',
      detail: `新增 ${accepted} 个，已存在 ${reused} 个${errors.length > 0 ? `，失败 ${errors.length} 个` : ''}`,
    });
    setMessage('网页正文已采集。需要时点开队列手动编译。');
    finishLater(errors.length > 0 ? 'error' : 'done');
  }

  async function digestQueue(queuedCount: number, errorCount: number) {
    setMood('digest');
    setMessage('正在消化材料，AI 编译会在后台继续。');
    try {
      const result = await processRawAssetQueue({
        owner: 'frog',
        compileWiki: true,
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
        x: clamp(startPosition.x + nextEvent.clientX - startX, 8, window.innerWidth - BROWSER_WIDGET_WIDTH),
        y: clamp(startPosition.y + nextEvent.clientY - startY, 8, window.innerHeight - BROWSER_WIDGET_HEIGHT),
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
  const widgetSizeClass = desktopShell ? 'frog-widget-compact w-[132px] rounded-[13px]' : 'w-[320px] rounded-[18px]';
  const widgetChromeClass = desktopShell
    ? 'border border-transparent bg-transparent p-1 shadow-none'
    : 'border border-[#d9e4d7] bg-[#fbfffb]/95 p-4 shadow-[0_20px_50px_rgb(31_41_55_/_0.16)] backdrop-blur';
  const dropZoneClass = desktopShell
    ? 'h-[120px] rounded-[13px] border-transparent px-1 pb-2 pt-5 shadow-[0_5px_14px_rgb(31_41_55_/_0.08)]'
    : 'h-[220px] rounded-[18px] px-3 pb-4 pt-7 shadow-[0_16px_40px_rgb(31_41_55_/_0.10)]';
  const dropZoneBaseClass = desktopShell
    ? 'frog-drop-zone pointer-events-none relative border border-transparent bg-white/55'
    : 'frog-drop-zone pointer-events-none relative border border-dashed border-[#cfe1cf] bg-white/80 backdrop-blur';
  const topControlClass = desktopShell ? 'absolute right-1 top-1 z-10 flex gap-1' : 'absolute right-3 top-3 z-10 flex gap-1';
  const iconButtonClass = desktopShell
    ? 'inline-flex h-5 w-5 items-center justify-center rounded-full border border-white/40 bg-white/65 text-[#4b5563] shadow-[0_2px_8px_rgb(31_41_55_/_0.10)]'
    : 'inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#d9e4d7] bg-white/90 text-[#4b5563] shadow-sm';
  const frogTopClass = desktopShell ? 'absolute inset-x-0 top-4' : 'absolute inset-x-0 top-8';
  const statusButtonLabel = desktopShell
    ? detailsOpen
      ? '收起状态'
      : isBusy
        ? '编译中'
        : '状态/队列'
    : detailsOpen
      ? '收起消化状态'
      : isBusy
        ? '正在消化，点开查看'
        : '消化状态与队列';

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
        className={`frog-widget fixed ${widgetSizeClass} ${mood === 'hover' ? 'frog-widget-hover' : ''} ${widgetChromeClass} ${isDraggingWidget ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{ left: position.x, top: position.y }}
        onPointerDown={handlePointerDown}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        aria-label="MyWiki 蛙蛙捕获入口"
      >
        <div className={topControlClass} data-no-widget-drag>
          <div className="hidden">
            <p className="text-xs font-medium text-[#155eef]">Froggy Capture</p>
            <h1 className="mt-1 text-base font-semibold">MyWiki 捕获蛙</h1>
          </div>
          {desktopShell ? (
            <button
              type="button"
              className={iconButtonClass}
              title="最小化"
              aria-label="最小化"
              data-no-widget-drag
              onClick={handleMinimize}
            >
              <Minus size={desktopShell ? 11 : 15} />
            </button>
          ) : null}
          {!desktopShell ? (
            <a
              href="/capture"
              className={iconButtonClass.replace('text-[#4b5563]', 'text-[#155eef]')}
              title="打开捕获页"
              aria-label="打开捕获页"
            >
              <FileDown size={17} />
            </a>
          ) : null}
        </div>

        <div className={`${dropZoneBaseClass} ${dropZoneClass}`}>
          <div className={frogTopClass}>
            <FrogFace mood={mood} />
          </div>
          {bubbleVisible ? (
            <div className={`frog-bubble frog-bubble-floating ${mood === 'idle' ? 'frog-bubble-idle' : ''} ${mood === 'done' ? 'frog-bubble-done' : mood === 'error' ? 'frog-bubble-error' : ''}`}>
              {bubbleMessage}
            </div>
          ) : null}
          <p className={`absolute inset-x-0 text-center text-[#65736a] ${desktopShell ? 'bottom-2 text-[10px] leading-none' : 'bottom-4 text-xs'}`}>
            {desktopShell ? '拖入 / 粘贴' : '拖入文件 / 粘贴图片或文本'}
          </p>
        </div>

        <button
          type="button"
          className={`flex w-full items-center justify-between rounded-full text-[#2f3f35] ${desktopShell ? 'mt-1 border border-white/40 bg-white/65 px-2 py-1 text-[10px] leading-none shadow-[0_3px_10px_rgb(31_41_55_/_0.09)]' : 'mt-2 border border-[#d9e4d7] bg-white/90 px-3 py-2 text-xs shadow-sm'}`}
          data-no-widget-drag
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setDetailsOpen((open) => !open)}
          aria-expanded={detailsOpen}
        >
          <span className="inline-flex items-center gap-1.5">
            <Settings2 size={desktopShell ? 11 : 13} />
            {statusButtonLabel}
          </span>
          {detailsOpen ? <ChevronUp size={desktopShell ? 12 : 14} /> : <ChevronDown size={desktopShell ? 12 : 14} />}
        </button>

        <div
          className={detailsOpen ? (desktopShell ? 'frog-details-compact block max-h-[214px] overflow-y-auto pr-0.5' : 'block') : 'hidden'}
          data-no-widget-drag
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className={desktopShell ? 'mt-1 flex items-center justify-end rounded-[9px] border border-white/35 bg-white/60 px-1.5 py-1' : 'mt-2 flex items-center justify-end rounded-[12px] border border-[#e2ebe1] bg-white/95 px-3 py-2'}>
          <button
            type="button"
            className={desktopShell ? 'inline-flex items-center gap-1 rounded-full border border-white/40 bg-white/45 px-1.5 py-0.5 text-[10px] leading-none text-[#155eef] disabled:text-[#8a968e]' : 'inline-flex items-center gap-1 rounded-full border border-[#d9e4d7] px-2 py-1 text-xs text-[#155eef] disabled:text-[#8a968e]'}
            disabled={isBusy || queueRunning}
            onClick={() => {
              setMood('digest');
              setIsBusy(true);
              void digestQueue(0, 0);
            }}
          >
            {isBusy || queueRunning ? <Loader2 size={desktopShell ? 10 : 13} className="animate-spin" /> : <RotateCcw size={desktopShell ? 10 : 13} />}
            {queueRunning ? `编译中 ${queueStatus?.percent ?? 0}%` : '编译队列'}
          </button>
        </div>

        {progress ? <FrogProgress progress={progress} compact={desktopShell} /> : null}

        <div className={desktopShell ? 'mt-1.5 rounded-[9px] border border-white/35 bg-white/60 px-1.5 py-1.5' : 'mt-3 rounded-[12px] border border-[#e2ebe1] bg-white px-3 py-2'}>
          <div className={desktopShell ? 'grid gap-0.5 text-[10px] leading-tight' : 'flex items-center justify-between gap-2 text-xs'}>
            <span className="shrink-0 font-medium text-[#1f2937]">最近状态</span>
            <span className={desktopShell ? 'text-[9px] text-[#65736a]' : 'shrink-0 text-[11px] text-[#65736a]'}>
              最近 {rawAssets?.length ?? 0} / 共 {rawAssetStats?.total ?? 0} 条
            </span>
          </div>
          <div className={desktopShell ? 'mt-1 grid gap-0.5 text-[9px] leading-tight text-[#65736a]' : 'mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-[#65736a]'}>
            <span>{desktopShell ? '待处理' : '待编译/处理中'} {rawAssetStats?.pending ?? 0}</span>
            <span>已入库 {rawAssetStats?.compiled ?? 0}</span>
            {(rawAssetStats?.skipped ?? 0) > 0 ? <span>已跳过 {rawAssetStats?.skipped ?? 0}</span> : null}
            {(rawAssetStats?.failed ?? 0) > 0 ? <span className="text-[#b42318]">失败 {rawAssetStats?.failed ?? 0}</span> : null}
          </div>
          {rawAssets && rawAssets.length > 0 ? (
            <div className={desktopShell ? 'mt-1.5 space-y-1' : 'mt-2 space-y-1.5'}>
              {rawAssets.map((asset) => (
                <FrogRecentAsset key={asset.id} asset={asset} queueStatus={queueStatus} compact={desktopShell} />
              ))}
              {(rawAssetStats?.total ?? 0) > rawAssets.length ? (
                <p className={desktopShell ? 'px-0.5 text-[9px] leading-tight text-[#7a827c]' : 'px-1 text-[11px] text-[#7a827c]'}>
                  {desktopShell ? '仅显示最近 5 条。' : '这里只显示最近 5 条，完整列表在捕获页 Raw Inbox。'}
                </p>
              ) : null}
            </div>
          ) : (
            <p className={desktopShell ? 'mt-1 text-[10px] text-[#65736a]' : 'mt-2 text-xs text-[#65736a]'}>等待投喂。</p>
          )}
        </div>

        <div className={desktopShell ? 'mt-1.5 grid gap-1 text-[9px] leading-tight text-[#65736a]' : 'mt-3 grid gap-1.5 text-[11px] text-[#65736a]'}>
          <span className="inline-flex min-w-0 items-start gap-1 leading-5">
            <Clipboard size={desktopShell ? 9 : 12} />
            <span>{desktopShell ? '文本/网页/Office/PDF/图片' : '支持文本、网页、表格、Word、PDF、图片'}</span>
          </span>
          <span className="inline-flex min-w-0 items-center gap-1 leading-5">
            <Settings2 size={desktopShell ? 9 : 12} />
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

function FrogRecentAsset({
  asset,
  queueStatus,
  compact = false,
}: {
  asset: { id: string; filename: string; status: RawAssetStatus; error?: string };
  queueStatus: RawAssetQueueSnapshot | null;
  compact?: boolean;
}) {
  const displayStatus = getDisplayRawAssetStatus(asset, queueStatus);
  const showError = displayStatus === 'failed' && asset.error;

  return (
    <div
      className={compact ? 'rounded-[7px] bg-white/45 px-1.5 py-1 text-[9px] leading-tight text-[#65736a]' : 'rounded-[8px] bg-[#f7fbf7] px-2 py-1.5 text-xs text-[#65736a]'}
      title={showError ? `${asset.filename}\n${asset.error}` : asset.filename}
    >
      <div className={compact ? 'grid gap-0.5' : 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2'}>
        <span className="min-w-0 truncate">{asset.filename}</span>
        <span
          className={[
            compact ? 'w-fit shrink-0 rounded-full border px-1 py-0.5 text-[8px] leading-none' : 'shrink-0 rounded-full border px-2 py-0.5',
            displayStatus === 'failed' ? 'border-[#fecaca] bg-[#fff5f5] text-[#b42318]' : 'border-[#d9e4d7]',
          ].join(' ')}
        >
          {statusLabel[displayStatus]}
        </span>
      </div>
      {showError ? <p className={compact ? 'mt-1 line-clamp-2 text-[8px] leading-tight text-[#b42318]' : 'mt-1 line-clamp-2 text-[11px] leading-4 text-[#b42318]'}>{asset.error}</p> : null}
    </div>
  );
}

function getDisplayRawAssetStatus(
  asset: { id: string; status: RawAssetStatus },
  queueStatus: RawAssetQueueSnapshot | null,
): RawAssetStatus {
  const isQueuedRetry =
    queueStatus?.stage === 'running' &&
    (asset.status === 'failed' || asset.status === 'wiki_failed') &&
    (queueStatus.currentAssetId === asset.id || Boolean(queueStatus.queuedAssetIds?.includes(asset.id)));
  return isQueuedRetry ? 'compiling' : asset.status;
}

function FrogProgress({ progress, compact = false }: { progress: ProgressState; compact?: boolean }) {
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
  return (
    <div className={compact ? 'mt-1.5 rounded-[9px] border border-white/35 bg-white/60 px-1.5 py-1.5' : 'mt-3 rounded-[12px] border border-[#e2ebe1] bg-white px-3 py-2'}>
      <div className={compact ? 'grid gap-0.5 text-[9px] leading-tight' : 'flex items-center justify-between gap-3 text-xs'}>
        <span className="inline-flex items-center gap-1 font-medium text-[#1f2937]">
          {percent >= 100 ? <Check size={compact ? 10 : 13} /> : <Loader2 size={compact ? 10 : 13} className="animate-spin" />}
          {progress.label}
        </span>
        <span className="tabular-nums text-[#155eef]">{percent}%</span>
      </div>
      <div className={compact ? 'mt-1 h-1.5 overflow-hidden rounded-full bg-[#edf4ee]' : 'mt-2 h-2 overflow-hidden rounded-full bg-[#edf4ee]'}>
        <div className="h-full rounded-full bg-[#27a65b] transition-all duration-300" style={{ width: `${percent}%` }} />
      </div>
      {progress.detail ? <p className={compact ? 'mt-1 text-[9px] leading-tight text-[#65736a]' : 'mt-1 text-xs leading-4 text-[#65736a]'}>{progress.detail}</p> : null}
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
    return { x: 5, y: 5 };
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
