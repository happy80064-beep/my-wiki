export type QueryComposeEntity = {
  id: string;
  type: string;
  title: string;
  summary: string;
};

export type QueryComposeTask = {
  id: string;
  description: string;
  status: string;
  dueDate?: string;
};

export type QueryComposeRelationship = {
  id: string;
  type: string;
  fromTitle: string;
  toTitle: string;
};

export type QueryComposeEntry = {
  id: string;
  content: string;
  scope?: 'entity-source' | 'global-fallback';
  matchedTerms?: string[];
};

export type QueryComposePayload = {
  question: string;
  draftAnswer: string;
  entities: QueryComposeEntity[];
  tasks: QueryComposeTask[];
  relationships: QueryComposeRelationship[];
  entries: QueryComposeEntry[];
};

export type QueryComposeResult = {
  answer: string;
  provider: string;
  model: string;
  fallbackFrom?: string;
};

export function buildQueryComposePrompt(payload: QueryComposePayload) {
  return `你是 MyWiki 的查询表达助手。系统已经用代码完成了结构化召回和过滤，你只负责把结果组织成自然、简洁、可信的中文回答。

用户问题：
${payload.question}

当前快速答案骨架：
${payload.draftAnswer}

已召回的结构化材料：
${JSON.stringify(
  {
    entities: payload.entities,
    tasks: payload.tasks,
    relationships: payload.relationships,
    entries: payload.entries,
  },
  null,
  2,
)}

回答要求：
- 只使用上面的已召回材料，不要编造新事实。
- “当前快速答案骨架”是本次回答的事实骨架；你的回答只能在它的基础上补充细节、依据和来源，不得换成另一套结论。
- 必须保留快速答案里的核心事实主张，包括数量、分类名称、实体名称、属性值和已列出的主要要点；可以改写语气，但不能删改结论。
- 如果你根据更完整证据确认快速答案里的数字或结论有误，必须以“已修正快速答案：”开头，并说明修正后的结论和原因；不得静默替换。
- 如果快速答案里出现“规则置信度：中”或“可能相关线索”，这些内容不是事实结论；你必须回到 entries 证据里确认后再表达，不能直接把线索当答案。
- 当前模板答案里的“运行环境/唤醒词/终止词/本地路径/开源状态”等属性行是结构化层抽取的硬结论，必须保留，不得改写成“没有找到/无法确认”。
- 直接回答用户问题，先给结论，再补充 2-4 条关键依据。
- 不要输出“根据材料”“模板答案”等系统过程词。
- 不要照搬零散字段；要合并同义信息，去掉调试口吻。
- 如果问题是“是谁/是什么/叫什么”，优先说明名称、身份/定位、与用户或项目的关系。
- 如果材料不足，明确说“目前知识库里只能确认...”并给出可继续追问的方向。
- 如果 entries 中有 scope=global-fallback，必须说明这是从全库原始材料兜底扫描得到的，还没有正式编译进实体页。
- 保留实体名、项目名、模型名等专有名词的原文写法。
- 不要输出思考过程，不要输出 <think> 标签或内部推理。
- 输出纯文本，不要 markdown 表格，不要 JSON，不要代码块。`;
}
