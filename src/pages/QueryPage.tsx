import { BookPlus, Check, CheckCircle2, Loader2, Search, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { type StructuredQueryResult, runStructuredQuery } from '@/lib/graph';
import { applyCompileSuggestion, dismissCompileSuggestion } from '@/lib/db';
import { saveQueryInsight } from '@/lib/query/saveInsight';

export function QueryPage() {
  const [question, setQuestion] = useState('桌面生命体叫什么');
  const [result, setResult] = useState<StructuredQueryResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [saveState, setSaveState] = useState<
    | { status: 'idle' }
    | { status: 'saving' }
    | { status: 'saved'; message: string; href: string }
    | { status: 'error'; message: string }
  >({ status: 'idle' });

  async function handleAsk() {
    if (!question.trim()) return;
    setIsLoading(true);
    setSaveState({ status: 'idle' });
    setResult(await runStructuredQuery(question, { composeWithLlm: true, planWithAgent: true }));
    setIsLoading(false);
  }

  async function handleApplyCompileSuggestion(
    suggestion: NonNullable<StructuredQueryResult['compileSuggestions']>[number],
  ) {
    const updated = await applyCompileSuggestion(suggestion.id);
    if (!updated) return;

    setResult((current) => replaceCompileSuggestion(current, updated));
  }

  async function handleDismissCompileSuggestion(
    suggestion: NonNullable<StructuredQueryResult['compileSuggestions']>[number],
  ) {
    const updated = await dismissCompileSuggestion(suggestion.id);
    if (!updated) return;

    setResult((current) => replaceCompileSuggestion(current, updated));
  }

  async function handleSaveInsight() {
    if (!result) return;
    setSaveState({ status: 'saving' });
    try {
      const saved = await saveQueryInsight(question, result);
      setSaveState({
        status: 'saved',
        message: saved.reused ? '已更新已有查询洞察。' : '已保存为查询洞察。',
        href: `/wiki/${saved.entity.type}/${saved.entity.id}`,
      });
    } catch (error) {
      setSaveState({
        status: 'error',
        message: error instanceof Error ? error.message : '保存失败。',
      });
    }
  }

  return (
    <section className="mx-auto max-w-6xl px-5 py-8">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <section className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
          <p className="text-xs font-medium text-[#155eef]">Query</p>
          <h2 className="mt-2 text-xl font-semibold text-[#1f2937]">结构化查询</h2>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            className="mt-5 min-h-32 w-full resize-y rounded-[12px] border border-[#d9d9d6] bg-[#fbfbfa] p-4 text-sm leading-6 outline-none transition focus:border-[#155eef] focus:bg-white"
          />
          <button
            type="button"
            onClick={handleAsk}
            disabled={!question.trim() || isLoading}
            className="mt-4 inline-flex items-center gap-2 rounded-full bg-[#155eef] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-[#a8b7d8]"
          >
            {isLoading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            查询
          </button>
          <p className="mt-4 text-sm leading-6 text-[#626965]">
            当前版本按 Wiki 阅读式查询执行：先扫知识目录，再读实体文档、关系子图和来源证据，最后组织回答。
          </p>
        </section>

        <section className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
          <p className="text-xs font-medium text-[#155eef]">Answer</p>
          <h2 className="mt-2 text-xl font-semibold text-[#1f2937]">回答</h2>
          {!result ? (
            <div className="mt-5 rounded-[12px] border border-dashed border-[#d9d9d6] bg-[#fbfbfa] p-6 text-sm leading-6 text-[#626965]">
              输入问题后，这里会展示结构化过滤后的答案和来源。
            </div>
          ) : (
            <div className="mt-5 space-y-5">
              <pre className="whitespace-pre-wrap rounded-[12px] border border-[#e5e5e4] bg-[#fbfbfa] p-4 text-sm leading-7 text-[#1f2937]">
                {result.answer}
              </pre>
              {result.llm ? (
                <p className="text-xs text-[#626965]">
                  已由 {providerTypeLabel[result.llm.provider]} · {result.llm.model} 优化表达
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleSaveInsight}
                  disabled={saveState.status === 'saving'}
                  className="inline-flex items-center gap-2 rounded-full border border-[#155eef] px-3 py-1.5 text-xs font-medium text-[#155eef] disabled:border-[#a8b7d8] disabled:text-[#7b8794]"
                >
                  {saveState.status === 'saving' ? <Loader2 size={14} className="animate-spin" /> : <BookPlus size={14} />}
                  保存到 Wiki
                </button>
                {saveState.status === 'saved' ? (
                  <Link to={saveState.href} className="inline-flex items-center gap-1 text-xs text-[#276749]">
                    <CheckCircle2 size={14} />
                    {saveState.message}
                  </Link>
                ) : null}
                {saveState.status === 'error' ? (
                  <span className="text-xs text-[#b42318]">{saveState.message}</span>
                ) : null}
              </div>

              {result.compileSuggestions && result.compileSuggestions.length > 0 ? (
                <div>
                  <h3 className="text-sm font-semibold text-[#1f2937]">待编译回 Wiki</h3>
                  <div className="mt-2 grid gap-2">
                    {result.compileSuggestions.map((suggestion) => {
                      const settled = suggestion.status !== 'pending';
                      return (
                        <div
                          key={suggestion.id}
                          className="rounded-[10px] border border-[#d9d9d6] bg-[#fbfbfa] p-3 text-xs leading-5"
                        >
                          <div className="grid gap-1">
                            <div className="font-medium text-[#1f2937]">建议写回 Wiki</div>
                            <div className="text-[#626965]">
                              实体：<span className="text-[#1f2937]">{suggestion.entityTitle}</span>
                            </div>
                            <div className="text-[#626965]">
                              字段：<span className="text-[#1f2937]">{suggestion.propertyLabel}</span>
                            </div>
                            <div className="text-[#626965]">
                              建议值：<span className="text-[#1f2937]">{suggestion.propertyValue}</span>
                            </div>
                            <div className="flex flex-wrap gap-2 text-[#626965]">
                              <span>
                                状态：
                                <span className="text-[#1f2937]">{compileSuggestionStatusLabel[suggestion.status]}</span>
                              </span>
                              <span>
                                证据范围：
                                <span className="text-[#1f2937]">{evidenceScopeLabel[suggestion.evidenceScope]}</span>
                              </span>
                              <span>
                                置信度：
                                <span className="text-[#1f2937]">{confidenceLabel(suggestion.confidence)}</span>
                              </span>
                            </div>
                            <div className="mt-1 rounded-[8px] border border-[#e5e5e4] bg-white px-3 py-2 text-[#626965]">
                              证据：{suggestion.evidenceSnippet}
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => handleApplyCompileSuggestion(suggestion)}
                              disabled={settled}
                              className="inline-flex items-center gap-1 rounded-full border border-[#155eef] px-3 py-1 text-xs font-medium text-[#155eef] disabled:border-[#a8b7d8] disabled:text-[#7b8794]"
                            >
                              <Check size={13} />
                              {suggestion.status === 'applied' ? '已写回' : '确认写回'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDismissCompileSuggestion(suggestion)}
                              disabled={settled}
                              className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-3 py-1 text-xs font-medium text-[#4b5563] disabled:text-[#9ca3af]"
                            >
                              <X size={13} />
                              忽略
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div>
                <h3 className="text-sm font-semibold text-[#1f2937]">来源</h3>
                {result.sources.length === 0 ? (
                  <p className="mt-2 text-sm text-[#626965]">暂无来源。</p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {result.sources.map((source) =>
                      source.href ? (
                        <Link
                          key={`${source.type}:${source.id}`}
                          to={source.href}
                          className="rounded-full border border-[#d9d9d6] px-3 py-1 text-xs text-[#155eef]"
                        >
                          {sourceTypeLabel[source.type]} · {source.title}
                        </Link>
                      ) : (
                        <span
                          key={`${source.type}:${source.id}`}
                          className="rounded-full border border-[#d9d9d6] px-3 py-1 text-xs text-[#626965]"
                        >
                          {sourceTypeLabel[source.type]} · {source.title}
                        </span>
                      ),
                    )}
                  </div>
                )}
              </div>

              {result.trace && result.trace.length > 0 ? (
                <div>
                  <h3 className="text-sm font-semibold text-[#1f2937]">扫描轨迹</h3>
                  <div className="mt-2 grid gap-2">
                    {result.trace.map((step, index) => (
                      <div
                        key={`${step.layer}:${index}`}
                        className="rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] px-3 py-2 text-xs leading-5"
                      >
                        <div className="font-medium text-[#1f2937]">{step.label}</div>
                        <div className="text-[#626965]">{step.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div>
                <h3 className="text-sm font-semibold text-[#1f2937]">追问建议</h3>
                <div className="mt-2 flex flex-wrap gap-2">
                  {result.suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => setQuestion(suggestion)}
                      className="rounded-full border border-[#d9d9d6] px-3 py-1 text-xs text-[#4b5563]"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

const sourceTypeLabel: Record<StructuredQueryResult['sources'][number]['type'], string> = {
  entity: '实体',
  task: '任务',
  entry: '原文',
};

const providerTypeLabel: Record<NonNullable<StructuredQueryResult['llm']>['provider'], string> = {
  minimax: 'MiniMax',
  deepseek: 'DeepSeek',
};

const evidenceScopeLabel: Record<NonNullable<StructuredQueryResult['compileSuggestions']>[number]['evidenceScope'], string> = {
  'entity-source': '关联原始材料',
  'global-fallback': '全库兜底',
};

const compileSuggestionStatusLabel: Record<NonNullable<StructuredQueryResult['compileSuggestions']>[number]['status'], string> = {
  pending: '待确认',
  applied: '已写回',
  dismissed: '已忽略',
  superseded: '已自动消解',
};

function replaceCompileSuggestion(
  result: StructuredQueryResult | null,
  suggestion: NonNullable<StructuredQueryResult['compileSuggestions']>[number],
) {
  if (!result?.compileSuggestions) return result;

  return {
    ...result,
    compileSuggestions: result.compileSuggestions.map((item) =>
      item.id === suggestion.id ? suggestion : item,
    ),
  };
}

function confidenceLabel(confidence: number) {
  if (confidence >= 0.8) return '高';
  if (confidence >= 0.65) return '中';
  return '低';
}
