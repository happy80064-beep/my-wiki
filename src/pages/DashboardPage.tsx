import { Archive, Database, Search, Sparkles } from 'lucide-react';

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
    </section>
  );
}
