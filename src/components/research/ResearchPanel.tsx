import { AlertCircle, CheckCircle2, FileText, Loader2, Search, Send, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { QueryAnswerRenderer } from '@/components/query/QueryAnswerRenderer';
import { useResearchStore, type ResearchTask } from '@/lib/research/store';

type ResearchPanelProps = {
  compact?: boolean;
};

export function ResearchPanel({ compact = false }: ResearchPanelProps) {
  const tasks = useResearchStore((state) => state.tasks);
  const queueResearch = useResearchStore((state) => state.queueResearch);
  const removeTask = useResearchStore((state) => state.removeTask);
  const [topic, setTopic] = useState('');

  function startResearch() {
    const trimmed = topic.trim();
    if (!trimmed) return;
    queueResearch(trimmed);
    setTopic('');
  }

  return (
    <section className="flex min-h-0 flex-col rounded-[12px] border border-[#e5e5e4] bg-white">
      <header className="shrink-0 border-b border-[#ececea] px-4 py-3">
        <div className="flex items-start gap-2">
          <Search size={16} className="mt-0.5 text-[#155eef]" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-[#1f2937]">Deep Research</h3>
              {tasks.some((task) => isRunning(task.status)) ? (
                <span className="rounded-full bg-[#eef4ff] px-2 py-0.5 text-[11px] text-[#155eef]">执行中</span>
              ) : null}
            </div>
            <p className="mt-1 text-xs leading-5 text-[#626965]">网页搜索、总结并保存为可入库的研究条目。</p>
          </div>
        </div>
      </header>

      <div className="shrink-0 border-b border-[#ececea] p-3">
        <div className="flex items-center gap-2">
          <input
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') startResearch();
            }}
            className="h-9 min-w-0 flex-1 rounded-[8px] border border-[#d9d9d6] px-3 text-sm outline-none focus:border-[#155eef]"
            placeholder="输入要补充研究的主题..."
          />
          <button
            type="button"
            onClick={startResearch}
            disabled={!topic.trim()}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-[#155eef] text-white disabled:bg-[#a9b8e8]"
            title="开始深度研究"
          >
            <Send size={15} />
          </button>
        </div>
      </div>

      <div className={['min-h-0 flex-1 overflow-auto p-3', compact ? 'max-h-[420px]' : ''].join(' ')}>
        {tasks.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-[#d9d9d6] bg-[#fbfbfa] p-4 text-sm leading-6 text-[#626965]">
            研究任务会显示在这里。完成后会保存为原始研究条目，并尝试自动摄入 Wiki。
          </div>
        ) : (
          <div className="grid gap-3">
            {tasks.map((task) => (
              <ResearchTaskCard key={task.id} task={task} onRemove={removeTask} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ResearchTaskCard({ task, onRemove }: { task: ResearchTask; onRemove: (id: string) => void }) {
  const [expanded, setExpanded] = useState(task.status !== 'done');
  const Icon = statusIcon(task.status);

  return (
    <article className="rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] text-sm">
      <button
        type="button"
        className="flex w-full items-start gap-2 px-3 py-2 text-left"
        onClick={() => setExpanded((value) => !value)}
      >
        <Icon size={15} className={['mt-0.5 shrink-0', statusTone(task.status), isRunning(task.status) ? 'animate-spin' : ''].join(' ')} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-[#1f2937]">{task.topic}</span>
          <span className="mt-0.5 block text-xs text-[#626965]">{statusLabel(task.status)}</span>
        </span>
        {(task.status === 'done' || task.status === 'error') ? (
          <span
            role="button"
            tabIndex={0}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-[#d9d9d6] bg-white text-[#626965]"
            onClick={(event) => {
              event.stopPropagation();
              onRemove(task.id);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onRemove(task.id);
            }}
          >
            <X size={12} />
          </span>
        ) : null}
      </button>

      {expanded ? (
        <div className="border-t border-[#e5e5e4] px-3 py-3">
          {task.error ? <p className="mb-2 text-xs leading-5 text-[#b42318]">{task.error}</p> : null}

          {task.webResults.length > 0 ? (
            <div className="mb-3">
              <p className="mb-2 text-xs font-semibold text-[#626965]">Sources ({task.webResults.length})</p>
              <div className="grid gap-1.5">
                {task.webResults.slice(0, 6).map((result, index) => (
                  <a
                    key={`${result.url}:${index}`}
                    href={result.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-[8px] border border-[#ececea] bg-white px-2 py-1.5 text-xs hover:border-[#155eef]"
                  >
                    <span className="font-mono text-[#8a8f89]">[{index + 1}] </span>
                    <span className="font-medium text-[#1f2937]">{result.title}</span>
                    <span className="mt-0.5 block truncate text-[#626965]">{result.source}</span>
                  </a>
                ))}
              </div>
            </div>
          ) : null}

          {task.synthesis ? (
            <div className="max-h-[280px] overflow-auto rounded-[10px] border border-[#e5e5e4] bg-white p-3">
              <QueryAnswerRenderer content={stripThinking(task.synthesis)} />
            </div>
          ) : null}

          {task.entryId ? (
            <Link
              to={`/entries/${task.entryId}`}
              className="mt-3 inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] bg-white px-3 py-1.5 text-xs text-[#155eef]"
            >
              <FileText size={13} />
              打开研究条目
            </Link>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function statusIcon(status: ResearchTask['status']) {
  if (isRunning(status)) return Loader2;
  if (status === 'done') return CheckCircle2;
  if (status === 'error') return AlertCircle;
  return Search;
}

function statusTone(status: ResearchTask['status']) {
  if (status === 'done') return 'text-[#16a34a]';
  if (status === 'error') return 'text-[#b42318]';
  return 'text-[#155eef]';
}

function statusLabel(status: ResearchTask['status']) {
  return {
    queued: '排队中',
    searching: '搜索网页资料',
    synthesizing: '综合研究结果',
    saving: '保存研究条目',
    ingesting: '自动摄入 Wiki',
    done: '已完成',
    error: '失败',
  }[status];
}

function isRunning(status: ResearchTask['status']) {
  return status === 'searching' || status === 'synthesizing' || status === 'saving' || status === 'ingesting';
}

function stripThinking(value: string) {
  return value
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/gi, '')
    .trim();
}
