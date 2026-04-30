import { AlertTriangle, Archive, CheckCircle2, Database, Info, Search, Sparkles } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { runWikiLint } from '@/lib/graph';

const milestones = [
  {
    icon: Database,
    title: '本地知识库',
    text: '四张核心表已作为 MVP 地基：entries、entities、relationships、tasks。',
  },
  {
    icon: Archive,
    title: '捕获闭环',
    text: '下一模块会优先打通文本捕获、AI 结构化建议和保存前编辑。',
  },
  {
    icon: Search,
    title: '精确召回',
    text: '查询会先走结构化过滤，再交给 AI 表达，避免任务归属污染。',
  },
];

export function DashboardPage() {
  const lintReport = useLiveQuery(() => runWikiLint(), [], undefined);
  const lintIssues = lintReport?.issues.slice(0, 6) ?? [];

  return (
    <section className="mx-auto max-w-6xl px-5 py-10">
      <div className="max-w-3xl">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#d9d9d6] bg-white px-3 py-1 text-xs text-[#155eef]">
          <Sparkles size={14} />
          工程骨架与数据层
        </div>
        <h2 className="text-3xl font-semibold tracking-normal text-[#1d1d1b]">
          第一版 MVP 已从稳定的数据地基开始。
        </h2>
        <p className="mt-4 text-sm leading-7 text-[#5f625f]">
          当前模块聚焦项目结构、类型系统和 IndexedDB 数据访问层。后续会按捕获、Wiki 浏览、AI 查询的顺序逐块开发，每块测试通过后再进入下一块。
        </p>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {milestones.map((item) => (
          <article key={item.title} className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
            <div className="mb-4 flex size-9 items-center justify-center rounded-[10px] bg-[#f4f8ff] text-[#155eef]">
              <item.icon size={18} />
            </div>
            <h3 className="text-sm font-semibold text-[#1f2937]">{item.title}</h3>
            <p className="mt-2 text-sm leading-6 text-[#626965]">{item.text}</p>
          </article>
        ))}
      </div>

      <section className="mt-8 rounded-[12px] border border-[#e5e5e4] bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-[#155eef]">Lint</p>
            <h3 className="mt-2 text-lg font-semibold text-[#1f2937]">知识库健康检查</h3>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <LintPill label="错误" value={lintReport?.summary.errors ?? 0} tone="error" />
            <LintPill label="警告" value={lintReport?.summary.warnings ?? 0} tone="warning" />
            <LintPill label="提示" value={lintReport?.summary.info ?? 0} tone="info" />
          </div>
        </div>

        {lintIssues.length === 0 ? (
          <div className="mt-4 flex items-center gap-2 rounded-[10px] border border-[#b7e4c7] bg-[#f0fff4] px-3 py-2 text-sm text-[#276749]">
            <CheckCircle2 size={16} />
            暂无明显健康问题。
          </div>
        ) : (
          <div className="mt-4 grid gap-2">
            {lintIssues.map((issue) => (
              <div key={issue.id} className="rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] px-3 py-2">
                <div className="flex items-center gap-2 text-sm font-medium text-[#1f2937]">
                  {issue.severity === 'error' ? (
                    <AlertTriangle size={15} className="text-[#b42318]" />
                  ) : (
                    <Info size={15} className={issue.severity === 'warning' ? 'text-[#a15c00]' : 'text-[#155eef]'} />
                  )}
                  {issue.title}
                </div>
                <p className="mt-1 text-xs leading-5 text-[#626965]">{issue.detail}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

function LintPill({ label, value, tone }: { label: string; value: number; tone: 'error' | 'warning' | 'info' }) {
  const toneClass = {
    error: 'border-[#fecaca] bg-[#fff5f5] text-[#b42318]',
    warning: 'border-[#fed7aa] bg-[#fff7ed] text-[#a15c00]',
    info: 'border-[#bfdbfe] bg-[#eff6ff] text-[#155eef]',
  }[tone];

  return <span className={`rounded-full border px-3 py-1 ${toneClass}`}>{label} {value}</span>;
}
