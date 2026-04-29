import { Loader2, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { type StructuredQueryResult, runStructuredQuery } from '@/lib/graph';

export function QueryPage() {
  const [question, setQuestion] = useState('桌面生命体叫什么');
  const [result, setResult] = useState<StructuredQueryResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleAsk() {
    if (!question.trim()) return;
    setIsLoading(true);
    setResult(await runStructuredQuery(question));
    setIsLoading(false);
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
