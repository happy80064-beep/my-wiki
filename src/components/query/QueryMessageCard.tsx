import {
  BookOpen,
  BookPlus,
  Check,
  CheckCircle2,
  Copy,
  FileText,
  Globe2,
  Layers,
  Loader2,
  Network,
  RefreshCw,
  Search,
  Tags,
  UserRound,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { applyCompileSuggestion, dismissCompileSuggestion } from '@/lib/db';
import type { QueryChatReference } from '@/lib/query/chatHelpers';
import { stripAnswerForCopy } from '@/lib/query/chatHelpers';
import type { QueryChatMessage } from '@/lib/query/chatStore';
import { saveQueryInsight } from '@/lib/query/saveInsight';
import { QueryAnswerRenderer } from './QueryAnswerRenderer';

type QueryMessageCardProps = {
  message: QueryChatMessage;
  isLastAssistant?: boolean;
  onRegenerate?: (message: QueryChatMessage) => Promise<void> | void;
  onDeepResearch?: (message: QueryChatMessage) => Promise<void> | void;
  onPrefillSuggestion?: (suggestion: string) => void;
  onMessageResultUpdate?: (messageId: string, result: NonNullable<QueryChatMessage['result']>) => void;
  selectedReferenceKey?: string;
  onReferenceSelect?: (reference: QueryChatReference) => void;
};

export function QueryMessageCard({
  message,
  isLastAssistant,
  onRegenerate,
  onDeepResearch,
  onPrefillSuggestion,
  onMessageResultUpdate,
  selectedReferenceKey,
  onReferenceSelect,
}: QueryMessageCardProps) {
  const isUser = message.role === 'user';
  const isResearch = isResearchMessage(message);
  const isResearchPending = isPendingResearchMessage(message);
  const hasAnswerText = Boolean(stripAnswerForCopy(message.content));
  const [copied, setCopied] = useState(false);
  const [saveState, setSaveState] = useState<
    | { status: 'idle' }
    | { status: 'saving' }
    | { status: 'saved'; href: string; message: string }
    | { status: 'error'; message: string }
  >({ status: 'idle' });

  async function handleCopy() {
    if (!hasAnswerText || isResearchPending) return;
    await navigator.clipboard.writeText(stripAnswerForCopy(message.content));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function handleSave() {
    if (!message.result || !message.question || isResearchPending || !hasAnswerText) return;
    setSaveState({ status: 'saving' });
    try {
      const saved = await saveQueryInsight(message.question, message.result);
      setSaveState({
        status: 'saved',
        href: `/wiki/${saved.entity.type}/${saved.entity.id}`,
        message: saved.reused ? '已更新查询洞察 Wiki 页面，并加入重新编译队列。' : '已保存为查询洞察 Wiki 页面，并加入重新编译队列。',
      });
    } catch (error) {
      setSaveState({
        status: 'error',
        message: error instanceof Error ? error.message : '保存失败。',
      });
    }
  }

  async function handleApplySuggestion(suggestionId: string) {
    const updated = await applyCompileSuggestion(suggestionId);
    if (!updated || !message.result || !onMessageResultUpdate) return;
    onMessageResultUpdate(message.id, {
      ...message.result,
      compileSuggestions: (message.result.compileSuggestions ?? []).map((item) =>
        item.id === updated.id ? updated : item,
      ),
    });
  }

  async function handleDismissSuggestion(suggestionId: string) {
    const updated = await dismissCompileSuggestion(suggestionId);
    if (!updated || !message.result || !onMessageResultUpdate) return;
    onMessageResultUpdate(message.id, {
      ...message.result,
      compileSuggestions: (message.result.compileSuggestions ?? []).map((item) =>
        item.id === updated.id ? updated : item,
      ),
    });
  }

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-[16px] bg-[#111827] px-4 py-3 text-sm leading-7 text-white shadow-[0_10px_30px_rgba(15,23,42,0.08)]">
          {message.content}
        </div>
      </div>
    );
  }

  const answerPanel = (
    <div className="space-y-2">
      {isResearch ? <div className="text-xs font-semibold uppercase tracking-[0.04em] text-[#155eef]">研究结论</div> : null}
      <article className="rounded-[18px] border border-[#e5e5e4] bg-white p-5 shadow-[0_12px_36px_rgba(15,23,42,0.04)]">
        {isResearchPending ? (
          <div className="space-y-2 text-sm text-[#4b5563]">
            <div className="inline-flex items-center gap-2 font-medium text-[#155eef]">
              <Loader2 size={15} className="animate-spin" />
              正在根据上方网页来源生成补充研究结论
            </div>
            <p className="leading-6 text-[#626965]">网页来源已经找到，正在整理和综合它们的关键信息。</p>
          </div>
        ) : (
          <QueryAnswerRenderer content={message.content} />
        )}
      </article>
    </div>
  );

  const directReferences = message.references?.filter((reference) => !isWeakReference(reference)) ?? [];
  const weakReferences = message.references?.filter(isWeakReference) ?? [];
  const primaryReferenceCount = isResearch ? directReferences.length : (message.references?.length ?? 0);
  const weakReferenceCount = isResearch ? weakReferences.length : 0;
  const primaryReferenceLabel = isResearch ? `项目事实来源（${primaryReferenceCount}）` : `参考来源（${primaryReferenceCount}）`;
  const referencePanel =
    message.references && message.references.length > 0 ? (
      <details className="rounded-[14px] border border-[#e5e5e4] bg-white px-4 py-3" open>
        <summary className="cursor-pointer list-none text-sm font-semibold text-[#1f2937]">
          {primaryReferenceLabel}
          {weakReferenceCount > 0 ? <span className="ml-2 text-xs font-normal text-[#6b6b68]">另有 {weakReferenceCount} 条方法参考材料</span> : null}
        </summary>
        <div className="mt-3 space-y-2">
          <ReferenceList
            references={isResearch ? directReferences : message.references}
            selectedReferenceKey={selectedReferenceKey}
            onReferenceSelect={onReferenceSelect}
          />
          {weakReferences.length > 0 ? (
            <details className="rounded-[12px] border border-dashed border-[#d9d9d6] bg-[#fbfbfa] px-3 py-2">
              <summary className="cursor-pointer list-none text-xs font-semibold text-[#626965]">
                方法参考材料（{weakReferences.length}）
                <span className="ml-2 font-normal">仅用于借鉴方法，不作为项目事实</span>
              </summary>
              <div className="mt-2 space-y-2">
                <ReferenceList
                  references={weakReferences}
                  selectedReferenceKey={selectedReferenceKey}
                  onReferenceSelect={onReferenceSelect}
                />
              </div>
            </details>
          ) : null}
          {isResearch && directReferences.length === 0 ? (
            <div className="rounded-[10px] border border-dashed border-[#d9d9d6] bg-[#fbfbfa] p-3 text-xs leading-5 text-[#626965]">
              未检索到可直接补充项目事实的网页来源；当前网页仅作为方法参考材料。
            </div>
          ) : null}
        </div>
      </details>
    ) : null;

  return (
    <div className="space-y-3">
      {isResearch ? (
        <>
          {referencePanel}
          {answerPanel}
        </>
      ) : (
        <>
          {answerPanel}
          {referencePanel}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => void handleCopy()}
          disabled={!hasAnswerText || isResearchPending}
          className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-3 py-1.5 text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef] disabled:cursor-not-allowed disabled:text-[#9ca3af]"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? '已复制' : '复制'}
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!message.result || saveState.status === 'saving' || !hasAnswerText || isResearchPending}
          className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-3 py-1.5 text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef] disabled:cursor-not-allowed disabled:text-[#9ca3af]"
        >
          {saveState.status === 'saving' ? <Loader2 size={13} className="animate-spin" /> : <BookPlus size={13} />}
          保存到 Wiki
        </button>
        {isLastAssistant && onRegenerate ? (
          <button
            type="button"
            onClick={() => void onRegenerate(message)}
            disabled={isResearchPending}
            className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-3 py-1.5 text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef] disabled:cursor-not-allowed disabled:text-[#9ca3af]"
          >
            <RefreshCw size={13} />
            重新生成
          </button>
        ) : null}
        {message.question && onDeepResearch ? (
          <button
            type="button"
            onClick={() => void onDeepResearch(message)}
            disabled={isResearchPending}
            className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-3 py-1.5 text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef] disabled:cursor-not-allowed disabled:text-[#9ca3af]"
          >
            <Search size={13} />
            补充/深度研究
          </button>
        ) : null}
        {saveState.status === 'saved' ? (
          <Link to={saveState.href} className="inline-flex items-center gap-1 text-[#276749] hover:underline">
            <CheckCircle2 size={13} />
            {saveState.message}
          </Link>
        ) : null}
        {saveState.status === 'error' ? <span className="text-[#b42318]">{saveState.message}</span> : null}
      </div>

      {message.result?.compileSuggestions?.length ? (
        <details className="rounded-[14px] border border-[#e5e5e4] bg-white px-4 py-3">
          <summary className="cursor-pointer list-none text-sm font-semibold text-[#1f2937]">
            待编译回 Wiki（{message.result.compileSuggestions.length}）
          </summary>
          <div className="mt-3 grid gap-3">
            {message.result.compileSuggestions.map((suggestion) => {
              const settled = suggestion.status !== 'pending';
              return (
                <div
                  key={suggestion.id}
                  className="rounded-[12px] border border-[#ececeb] bg-[#fbfbfa] p-3 text-xs leading-6 text-[#4b5563]"
                >
                  <div className="font-medium text-[#1f2937]">{suggestion.entityTitle}</div>
                  <div>字段：{suggestion.propertyLabel}</div>
                  <div>建议值：{suggestion.propertyValue}</div>
                  <div className="mt-1 text-[#6b6b68]">证据：{suggestion.evidenceSnippet}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void handleApplySuggestion(suggestion.id)}
                      disabled={settled}
                      className="inline-flex items-center gap-1 rounded-full border border-[#155eef] px-3 py-1 text-[#155eef] disabled:border-[#a8b7d8] disabled:text-[#8fa2d1]"
                    >
                      <Check size={12} />
                      {suggestion.status === 'applied' ? '已写回' : '确认写回'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDismissSuggestion(suggestion.id)}
                      disabled={settled}
                      className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-3 py-1 disabled:text-[#9ca3af]"
                    >
                      <X size={12} />
                      忽略
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      ) : null}

      {message.result?.trace?.length ? (
        <details className="rounded-[14px] border border-[#e5e5e4] bg-white px-4 py-3">
          <summary className="cursor-pointer list-none text-sm font-semibold text-[#1f2937]">查询轨迹</summary>
          <div className="mt-3 grid gap-2">
            {message.result.trace.map((step, index) => (
              <div
                key={`${step.layer}:${index}`}
                className="rounded-[10px] border border-[#ececeb] bg-[#fbfbfa] px-3 py-2 text-xs leading-6"
              >
                <div className="font-medium text-[#1f2937]">{step.label}</div>
                <div className="text-[#626965]">{step.detail}</div>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {message.result?.suggestions?.length ? (
        <div className="flex flex-wrap gap-2">
          {message.result.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onPrefillSuggestion?.(suggestion)}
              className="rounded-full border border-[#d9d9d6] px-3 py-1.5 text-xs text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef]"
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReferenceIcon({ reference }: { reference: QueryChatReference }) {
  const pageType = reference.preview?.kind === 'wiki' ? reference.preview.pageType : undefined;
  const sourceLike = reference.preview?.kind === 'source' || pageType === 'source';
  const webLike = reference.preview?.kind === 'web' || reference.type === 'web';
  const conceptLike = pageType === 'concept' || pageType === 'query' || pageType === 'synthesis';
  const relationLike = pageType === 'comparison' || pageType === 'project' || pageType === 'stakeholder';

  if (webLike) {
    return (
      <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-[#eef4ff] text-[#155eef]" title="网页">
        <Globe2 size={13} />
      </span>
    );
  }

  if (sourceLike) {
    return (
      <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-[#fff4e6] text-[#f97316]" title="来源">
        <BookOpen size={13} />
      </span>
    );
  }

  if (conceptLike) {
    return (
      <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-[#f5f3ff] text-[#7c3aed]" title="概念">
        <Tags size={13} />
      </span>
    );
  }

  if (relationLike) {
    return (
      <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-[#eef4ff] text-[#2563eb]" title="页面">
        <Network size={13} />
      </span>
    );
  }

  if (reference.type === 'entry') {
    return (
      <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-[#fff4e6] text-[#f97316]" title="原文">
        <FileText size={13} />
      </span>
    );
  }

  return (
    <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-[#edfdf8] text-[#0f9f6e]" title="实体">
      {pageType === 'overview' ? <Layers size={13} /> : <UserRound size={13} />}
    </span>
  );
}

function ReferenceList({
  references,
  selectedReferenceKey,
  onReferenceSelect,
}: {
  references: QueryChatReference[];
  selectedReferenceKey?: string;
  onReferenceSelect?: (reference: QueryChatReference) => void;
}) {
  if (references.length === 0) return null;
  return (
    <>
      {references.slice(0, 10).map((reference, index) => (
        <div key={reference.key} className="flex items-center gap-2 text-sm leading-6">
          <span className="text-[#8a8f89]">[{index + 1}]</span>
          <ReferenceIcon reference={reference} />
          <button
            type="button"
            onClick={() => onReferenceSelect?.(reference)}
            className={[
              'min-w-0 flex-1 truncate text-left text-[#155eef] hover:underline',
              selectedReferenceKey === reference.key ? 'font-semibold' : '',
            ].join(' ')}
            title={reference.title}
          >
            {reference.title}
          </button>
        </div>
      ))}
      {references.length > 10 ? (
        <div className="text-xs text-[#6b6b68]">还有 {references.length - 10} 条来源，后续可以继续展开查看。</div>
      ) : null}
    </>
  );
}

function isWeakReference(reference: QueryChatReference) {
  return reference.preview?.kind === 'web' && reference.preview.relevance === 'weak';
}

function isResearchMessage(message: QueryChatMessage) {
  return Boolean(
    message.references?.some((reference) => reference.type === 'web') ||
      message.result?.sources.some((source) => source.type === 'web') ||
      message.result?.trace?.some((step) => step.layer === 'web'),
  );
}

function isPendingResearchMessage(message: QueryChatMessage) {
  return isResearchMessage(message) && !message.result?.trace?.some((step) => step.layer === 'answer');
}
