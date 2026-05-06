import { Check, Clipboard, FileDown, Loader2, RotateCcw, Settings2 } from 'lucide-react';
import { type ClipboardEvent, type DragEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { createRawAssetFromFile, processNextRawAsset, resetStaleRawAssets } from '@/lib/rawAssets';
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
const FROG_AUTO_COMPILE_KEY = 'mywiki.froggy.autoCompile';

export function FrogWidgetPage() {
  const pageRef = useRef<HTMLElement | null>(null);
  const [mood, setMood] = useState<FrogMood>('idle');
  const [message, setMessage] = useState('把文件丢给我，我会先收进 Raw Inbox。');
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isDraggingWidget, setIsDraggingWidget] = useState(false);
  const [autoCompile, setAutoCompile] = useState(() => loadBoolean(FROG_AUTO_COMPILE_KEY, true));
  const [position, setPosition] = useState<WidgetPosition>(() => loadPosition());
  const rawAssets = useLiveQuery(() => db.rawAssets.orderBy('createdAt').reverse().limit(5).toArray(), [], []);

  const recentStatus = useMemo(() => {
    const latest = rawAssets?.[0];
    if (!latest) return '等待投喂';
    return `${latest.filename} · ${statusLabel[latest.status]}`;
  }, [rawAssets]);

  useEffect(() => {
    localStorage.setItem(FROG_AUTO_COMPILE_KEY, String(autoCompile));
  }, [autoCompile]);

  useEffect(() => {
    pageRef.current?.focus();
  }, []);

  useEffect(() => {
    localStorage.setItem(FROG_POSITION_KEY, JSON.stringify(position));
  }, [position]);

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (isBusy) return;
    setMood('hover');
    setMessage('松手，丢进嘴里。');
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    if (!isBusy) {
      setMood('idle');
      setMessage('把文件丢给我，我会先收进 Raw Inbox。');
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
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

    if (!autoCompile) {
      setMood('done');
      setProgress({
        percent: 100,
        label: '已采集到 Raw Inbox',
        detail: `新增 ${accepted} 个，已存在 ${reused} 个${errors.length > 0 ? `，跳过 ${errors.length} 个` : ''}`,
      });
      setMessage('已采集。稍后可在捕获页统一编译。');
      finishLater('done');
      return;
    }

    await digestQueue(accepted + reused, errors.length);
  }

  async function digestQueue(queuedCount: number, errorCount: number) {
    setMood('digest');
    setMessage('正在消化材料，AI 编译会在后台继续。');
    const recovered = await resetStaleRawAssets();
    const rawTotal =
      (await db.rawAssets.where('status').equals('raw').count()) +
      (await db.rawAssets.where('status').equals('failed').count());
    if (rawTotal === 0) {
      setMood('done');
      setProgress({ percent: 100, label: '已采集', detail: `新增/复用 ${queuedCount} 个` });
      setMessage('材料已在 Raw Inbox。');
      finishLater('done');
      return;
    }

    let processed = 0;
    for (let index = 0; index < rawTotal; index += 1) {
      const result = await processNextRawAsset(undefined, (current) => {
        setProgress({
          percent: Math.min(96, Math.round(((processed + current.percent / 100) / rawTotal) * 100)),
          label: current.label,
          detail: `${processed}/${rawTotal}${recovered > 0 ? ` · 已恢复 ${recovered} 个` : ''}`,
        });
      });
      if (!result) break;
      processed += 1;
      setProgress({
        percent: Math.round((processed / rawTotal) * 100),
        label: result.status === 'failed' ? `${result.filename} 编译失败` : `${result.filename} 已入库`,
        detail: `${processed}/${rawTotal}`,
      });
    }

    const failed = await db.rawAssets.where('status').equals('failed').count();
    if (failed > 0) {
      setMood('error');
      setMessage(`已采集，但还有 ${failed} 个材料需要重试。`);
      setProgress({ percent: 100, label: '部分材料未编译成功', detail: errorCount > 0 ? `另有 ${errorCount} 个跳过` : undefined });
      finishLater('error');
      return;
    }

    setMood('done');
    setProgress({ percent: 100, label: '已入库', detail: `本轮处理 ${processed} 个材料` });
    setMessage('已入库。');
    finishLater('done');
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
    if ((event.target as HTMLElement).closest('button,input')) return;
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
        className={`frog-widget fixed w-[320px] rounded-[18px] border border-[#d9e4d7] bg-[#fbfffb]/95 p-4 shadow-[0_20px_50px_rgb(31_41_55_/_0.16)] backdrop-blur ${isDraggingWidget ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{ left: position.x, top: position.y }}
        onPointerDown={handlePointerDown}
        aria-label="MyWiki 蛙蛙捕获入口"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-[#155eef]">Froggy Capture</p>
            <h1 className="mt-1 text-base font-semibold">MyWiki 捕获蛙</h1>
          </div>
          <a
            href="/capture"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#d9e4d7] bg-white text-[#155eef]"
            title="打开捕获页"
            aria-label="打开捕获页"
          >
            <FileDown size={17} />
          </a>
        </div>

        <div className="mt-3 rounded-[14px] border border-dashed border-[#cfe1cf] bg-white/80 p-3">
          <FrogFace mood={mood} />
          <div className={`frog-bubble mt-3 ${mood === 'done' ? 'frog-bubble-done' : mood === 'error' ? 'frog-bubble-error' : ''}`}>
            {message}
          </div>
          <p className="mt-2 text-center text-xs text-[#65736a]">拖入文件，或点一下窗口后粘贴图片/文本。</p>
        </div>

        <div className="mt-3 flex items-center justify-between rounded-[12px] border border-[#e2ebe1] bg-white px-3 py-2">
          <label className="flex items-center gap-2 text-xs text-[#2f3f35]">
            <input
              type="checkbox"
              checked={autoCompile}
              onChange={(event) => setAutoCompile(event.target.checked)}
              className="size-4 accent-[#155eef]"
            />
            自动消化
          </label>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full border border-[#d9e4d7] px-2 py-1 text-xs text-[#155eef] disabled:text-[#8a968e]"
            disabled={isBusy}
            onClick={() => {
              setMood('digest');
              setIsBusy(true);
              void digestQueue(0, 0);
            }}
          >
            {isBusy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
            编译队列
          </button>
        </div>

        {progress ? <FrogProgress progress={progress} /> : null}

        <div className="mt-3 rounded-[12px] border border-[#e2ebe1] bg-white px-3 py-2">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="font-medium text-[#1f2937]">最近状态</span>
            <span className="truncate text-[#65736a]">{recentStatus}</span>
          </div>
          {rawAssets && rawAssets.length > 0 ? (
            <div className="mt-2 space-y-1">
              {rawAssets.slice(0, 3).map((asset) => (
                <div key={asset.id} className="flex items-center justify-between gap-2 text-xs text-[#65736a]">
                  <span className="truncate">{asset.filename}</span>
                  <span className="shrink-0 rounded-full border border-[#d9e4d7] px-2 py-0.5">{statusLabel[asset.status]}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mt-3 flex items-center justify-between text-[11px] text-[#65736a]">
          <span className="inline-flex items-center gap-1">
            <Clipboard size={12} />
            支持文本、Word、PDF、图片
          </span>
          <span className="inline-flex items-center gap-1">
            <Settings2 size={12} />
            位置已记忆
          </span>
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
      {progress.detail ? <p className="mt-1 truncate text-xs text-[#65736a]">{progress.detail}</p> : null}
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
  if (mimeType.startsWith('text/')) return 'txt';
  return 'bin';
}

function loadPosition(): WidgetPosition {
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

function loadBoolean(key: string, fallback: boolean) {
  const value = localStorage.getItem(key);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
