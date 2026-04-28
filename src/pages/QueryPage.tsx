export function QueryPage() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-8">
      <div className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
        <p className="text-xs font-medium text-[#155eef]">Query</p>
        <h2 className="mt-2 text-xl font-semibold text-[#1f2937]">AI 查询待开发</h2>
        <p className="mt-3 text-sm leading-6 text-[#626965]">
          查询模块会先按结构化图数据过滤，再把结果交给 AI 生成自然语言回答。
        </p>
      </div>
    </section>
  );
}
