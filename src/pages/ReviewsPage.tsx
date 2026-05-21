import { AlertTriangle, Check, ExternalLink, FileText, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useLiveQuery } from '@/lib/db/liveQuery';
import { Link } from 'react-router';
import {
  applyCompileSuggestion,
  applyWikiReviewItem,
  db,
  dismissCompileSuggestion,
  dismissWikiReviewItem,
} from '@/lib/db';
import { syncWorkspaceRecordsToDefaultWorkspace } from '@/lib/workspace';
import type { CompileSuggestionRecord, CompileSuggestionStatus, WikiReviewRecord, WikiReviewStatus } from '@/types';

type ReviewFilter = WikiReviewStatus | 'all';

const statusLabels: Record<WikiReviewStatus, string> = {
  pending: '待确认',
  applied: '已写回',
  dismissed: '已保留人工内容',
  superseded: '已失效',
};

const filters: ReviewFilter[] = ['pending', 'applied', 'dismissed', 'superseded', 'all'];

export function ReviewsPage() {
  const [filter, setFilter] = useState<ReviewFilter>('pending');
  const [actionStatus, setActionStatus] = useState('');
  const suggestions = useLiveQuery(() => db.compileSuggestions.orderBy('updatedAt').reverse().toArray(), [], []);
  const wikiReviews = useLiveQuery(() => db.wikiReviewItems.orderBy('updatedAt').reverse().toArray(), [], []);
  const visibleWikiReviews = useMemo(
    () => wikiReviews.filter((review) => filter === 'all' || review.status === filter),
    [filter, wikiReviews],
  );
  const visibleSuggestions = useMemo(
    () => suggestions.filter((suggestion) => filter === 'all' || suggestion.status === filter),
    [filter, suggestions],
  );

  async function handleApplyWiki(review: WikiReviewRecord) {
    setActionStatus('');
    await applyWikiReviewItem(review.id);
    await syncWorkspaceRecordsToDefaultWorkspace();
    setActionStatus(`已应用 AI 更新：${review.entityTitle}。旧内容已保留为过期块。`);
  }

  async function handleDismissWiki(review: WikiReviewRecord) {
    setActionStatus('');
    await dismissWikiReviewItem(review.id);
    await syncWorkspaceRecordsToDefaultWorkspace();
    setActionStatus(`已保留人工编辑内容：${review.entityTitle}。`);
  }

  async function handleApplySuggestion(suggestion: CompileSuggestionRecord) {
    setActionStatus('');
    await applyCompileSuggestion(suggestion.id);
    await syncWorkspaceRecordsToDefaultWorkspace();
    setActionStatus(`已写回结构化建议：${suggestion.entityTitle}。`);
  }

  async function handleDismissSuggestion(suggestion: CompileSuggestionRecord) {
    setActionStatus('');
    await dismissCompileSuggestion(suggestion.id);
    await syncWorkspaceRecordsToDefaultWorkspace();
    setActionStatus(`已忽略结构化建议：${suggestion.entityTitle}。`);
  }

  return (
    <section className="mx-auto max-w-6xl px-5 py-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-[#155eef]">Review</p>
          <h2 className="mt-2 text-2xl font-semibold text-[#1f2937]">审核队列</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#626965]">
            人工编辑过的 Wiki 页不会被 AI 重编译直接覆盖；有差异时会进入这里，由你决定是否把 AI 新结果写回。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {filters.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setFilter(item)}
              className={[
                'rounded-full border px-3 py-1.5 text-xs transition',
                filter === item
                  ? 'border-[#155eef] bg-[#f4f8ff] text-[#155eef]'
                  : 'border-[#d9d9d6] bg-white text-[#4b5563]',
              ].join(' ')}
            >
              {item === 'all' ? '全部' : statusLabels[item]}
            </button>
          ))}
        </div>
      </div>

      {actionStatus ? (
        <div className="mb-5 rounded-[12px] border border-[#dbe7ff] bg-[#f5f8ff] px-4 py-3 text-sm text-[#315078]">
          {actionStatus}
        </div>
      ) : null}

      <div className="grid gap-8">
        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-lg font-semibold text-[#1f2937]">Wiki 页面更新审核</h3>
            <span className="text-sm text-[#626965]">{visibleWikiReviews.length} 项</span>
          </div>
          <div className="grid gap-4">
            {visibleWikiReviews.length === 0 ? (
              <EmptyReviewState label="当前筛选下没有 Wiki 页面审核项。" />
            ) : (
              visibleWikiReviews.map((review) => (
                <WikiReviewCard
                  key={review.id}
                  review={review}
                  onApply={() => handleApplyWiki(review)}
                  onDismiss={() => handleDismissWiki(review)}
                />
              ))
            )}
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-lg font-semibold text-[#1f2937]">结构化字段写回审核</h3>
            <span className="text-sm text-[#626965]">{visibleSuggestions.length} 项</span>
          </div>
          <div className="grid gap-4">
            {visibleSuggestions.length === 0 ? (
              <EmptyReviewState label="当前筛选下没有结构化字段建议。" />
            ) : (
              visibleSuggestions.map((suggestion) => (
                <CompileSuggestionCard
                  key={suggestion.id}
                  suggestion={suggestion}
                  onApply={() => handleApplySuggestion(suggestion)}
                  onDismiss={() => handleDismissSuggestion(suggestion)}
                />
              ))
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function WikiReviewCard({
  review,
  onApply,
  onDismiss,
}: {
  review: WikiReviewRecord;
  onApply: () => void;
  onDismiss: () => void;
}) {
  return (
    <article className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-[#d9d9d6] bg-[#fbfbfa] px-2.5 py-1 text-xs text-[#4b5563]">
              {statusLabels[review.status]}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-[#f2d08f] bg-[#fff8e6] px-2.5 py-1 text-xs text-[#6f4a00]">
              <AlertTriangle size={13} />
              人工编辑冲突
            </span>
          </div>
          <h4 className="mt-3 text-base font-semibold text-[#1f2937] [overflow-wrap:anywhere]">{review.entityTitle}</h4>
          <p className="mt-2 text-sm leading-6 text-[#626965]">{review.reason}</p>
          <p className="mt-1 text-xs text-[#8a8f89]">
            {formatReviewSource(review)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to={`/wiki?ref=${encodeURIComponent(review.entityTitle)}`}
            className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-3 py-1.5 text-xs text-[#155eef]"
          >
            <ExternalLink size={13} />
            打开页面
          </Link>
          {review.status === 'pending' ? (
            <>
              <button
                type="button"
                onClick={onApply}
                className="inline-flex items-center gap-1 rounded-full border border-[#155eef] px-3 py-1.5 text-xs font-medium text-[#155eef]"
              >
                <Check size={13} />
                使用 AI 更新
              </button>
              <button
                type="button"
                onClick={onDismiss}
                className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-3 py-1.5 text-xs font-medium text-[#4b5563]"
              >
                <X size={13} />
                保留人工内容
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        <PreviewBlock title="当前人工版本" markdown={review.currentMarkdown} />
        <PreviewBlock title="AI 重编译版本" markdown={review.proposedMarkdown} />
      </div>
      <p className="mt-3 text-xs leading-5 text-[#626965]">
        选择“使用 AI 更新”后，新内容会写入对应位置；被替换的旧内容会保留在页面中，并标记为过期，后续查询默认忽略。
      </p>
    </article>
  );
}

function CompileSuggestionCard({
  suggestion,
  onApply,
  onDismiss,
}: {
  suggestion: CompileSuggestionRecord;
  onApply: () => void;
  onDismiss: () => void;
}) {
  return (
    <article className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-[#d9d9d6] bg-[#fbfbfa] px-2.5 py-1 text-xs text-[#4b5563]">
              {statusLabels[suggestion.status as CompileSuggestionStatus]}
            </span>
            <h4 className="text-base font-semibold text-[#1f2937]">{suggestion.entityTitle}</h4>
          </div>
          <p className="mt-2 text-sm text-[#626965]">
            {suggestion.propertyLabel}：<span className="font-medium text-[#1f2937]">{suggestion.propertyValue}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to={`/entries/${suggestion.evidenceEntryId}`}
            className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-3 py-1.5 text-xs text-[#155eef]"
          >
            <FileText size={13} />
            查看证据
          </Link>
          {suggestion.status === 'pending' ? (
            <>
              <button
                type="button"
                onClick={onApply}
                className="inline-flex items-center gap-1 rounded-full border border-[#155eef] px-3 py-1.5 text-xs font-medium text-[#155eef]"
              >
                <Check size={13} />
                确认写回
              </button>
              <button
                type="button"
                onClick={onDismiss}
                className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-3 py-1.5 text-xs font-medium text-[#4b5563]"
              >
                <X size={13} />
                忽略
              </button>
            </>
          ) : null}
        </div>
      </div>
      <div className="mt-4 rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] px-3 py-2 text-sm leading-6 text-[#4b5563]">
        {suggestion.evidenceSnippet}
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-[#626965]">
        <span>字段：{suggestion.propertyKey}</span>
        <span>置信度：{Math.round(suggestion.confidence * 100)}%</span>
      </div>
    </article>
  );
}

function PreviewBlock({ title, markdown }: { title: string; markdown: string }) {
  return (
    <div className="rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-[#8a8f89]">{title}</p>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs leading-5 text-[#4b5563] [overflow-wrap:anywhere]">
        {previewMarkdown(markdown)}
      </pre>
    </div>
  );
}

function EmptyReviewState({ label }: { label: string }) {
  return (
    <div className="rounded-[12px] border border-dashed border-[#d9d9d6] bg-[#fbfbfa] p-8 text-sm text-[#626965]">
      {label}
    </div>
  );
}

function previewMarkdown(markdown: string) {
  const trimmed = markdown.trim();
  if (!trimmed) return '无内容';
  return trimmed.length > 1800 ? `${trimmed.slice(0, 1800).trim()}\n\n...` : trimmed;
}

function formatReviewSource(review: WikiReviewRecord) {
  const model = [review.provider, review.model].filter(Boolean).join(':');
  return [review.sourceLabel, model, new Date(review.updatedAt).toLocaleString()].filter(Boolean).join(' · ');
}
