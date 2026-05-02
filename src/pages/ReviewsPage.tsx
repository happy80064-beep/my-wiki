import { Check, FileText, X } from 'lucide-react';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router';
import { applyCompileSuggestion, db, dismissCompileSuggestion } from '@/lib/db';
import type { CompileSuggestionRecord, CompileSuggestionStatus } from '@/types';

const statusLabels: Record<CompileSuggestionStatus, string> = {
  pending: '待确认',
  applied: '已写回',
  dismissed: '已忽略',
  superseded: '已消解',
};

const filters: Array<CompileSuggestionStatus | 'all'> = ['pending', 'applied', 'dismissed', 'superseded', 'all'];

export function ReviewsPage() {
  const [filter, setFilter] = useState<CompileSuggestionStatus | 'all'>('pending');
  const suggestions = useLiveQuery(
    () => db.compileSuggestions.orderBy('updatedAt').reverse().toArray(),
    [],
    [],
  );
  const visibleSuggestions = suggestions.filter((suggestion) => filter === 'all' || suggestion.status === filter);

  async function handleApply(suggestion: CompileSuggestionRecord) {
    await applyCompileSuggestion(suggestion.id);
  }

  async function handleDismiss(suggestion: CompileSuggestionRecord) {
    await dismissCompileSuggestion(suggestion.id);
  }

  return (
    <section className="mx-auto max-w-6xl px-5 py-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-[#155eef]">Review</p>
          <h2 className="mt-2 text-2xl font-semibold text-[#1f2937]">待编译队列</h2>
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

      <div className="grid gap-4">
        {visibleSuggestions.length === 0 ? (
          <div className="rounded-[12px] border border-[#e5e5e4] bg-white p-8 text-sm text-[#626965]">
            当前筛选下没有待处理项。
          </div>
        ) : (
          visibleSuggestions.map((suggestion) => (
            <article key={suggestion.id} className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-[#d9d9d6] bg-[#fbfbfa] px-2.5 py-1 text-xs text-[#4b5563]">
                      {statusLabels[suggestion.status]}
                    </span>
                    <h3 className="text-base font-semibold text-[#1f2937]">{suggestion.entityTitle}</h3>
                  </div>
                  <p className="mt-2 text-sm text-[#626965]">
                    {suggestion.propertyLabel}：
                    <span className="font-medium text-[#1f2937]">{suggestion.propertyValue}</span>
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
                        onClick={() => handleApply(suggestion)}
                        className="inline-flex items-center gap-1 rounded-full border border-[#155eef] px-3 py-1.5 text-xs font-medium text-[#155eef]"
                      >
                        <Check size={13} />
                        确认写回
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDismiss(suggestion)}
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
                <span>证据范围：{suggestion.evidenceScope === 'entity-source' ? '关联原始材料' : '全库兜底'}</span>
                <span>置信度：{Math.round(suggestion.confidence * 100)}%</span>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
