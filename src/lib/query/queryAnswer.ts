import type { RuntimeProviderTiming } from '@/lib/llm/runtimeProvider';
import { queryUnderstandingForPrompt, understandQuery } from './queryUnderstanding';

export type QueryAnswerPageContext = {
  index: number;
  entityId: string;
  type: string;
  title: string;
  href: string;
  path?: string;
  summary: string;
  content: string;
  score: number;
  tags?: string[];
  sources?: string[];
  related?: string[];
  updated?: string;
};

export type QueryAnswerRequest = {
  question: string;
  indexSummary: string;
  pages: QueryAnswerPageContext[];
  structuredSupport?: {
    draftAnswer?: string;
    keyHints?: string[];
  };
  conversationContext?: QueryConversationContextMessage[];
};

export type QueryAnswerResponse = {
  answer: string;
  citedIndices: number[];
  provider: string;
  model: string;
  fallbackFrom?: string;
  llmTiming?: RuntimeProviderTiming;
};

export type QueryConversationContextMessage = {
  role: 'user' | 'assistant';
  content: string;
  references?: Array<{ title: string; href?: string }>;
};

const citedPattern = /<!--\s*cited:\s*([\d,\s，、]+)\s*-->/gi;

export function buildQueryAnswerPrompt(payload: QueryAnswerRequest) {
  const pageList = payload.pages.map((page) => `[${page.index}] ${page.title} (${page.type})`).join('\n');
  const pageBlocks = payload.pages
    .map((page) =>
      [
        `## [${page.index}] ${page.title}`,
        `Type: ${page.type}`,
        `Href: ${page.href}`,
        page.summary ? `Summary: ${page.summary}` : '',
        '',
        page.content.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n---\n\n');

  const structuredSupport = payload.structuredSupport
    ? [
        '## Structured Support (secondary, use only as hints when the wiki pages are incomplete)',
        payload.structuredSupport.draftAnswer ? `Draft answer: ${payload.structuredSupport.draftAnswer}` : '',
        payload.structuredSupport.keyHints?.length
          ? `Key hints:\n${payload.structuredSupport.keyHints.map((hint) => `- ${hint}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
    .join('\n')
    : '';
  const conversationContext = buildConversationContextBlock(payload.conversationContext);
  const queryUnderstanding = queryUnderstandingForPrompt(understandQuery(payload.question));

  return [
    '你是 MyWiki Query 2.0 的中文 Wiki 对话分析助手。',
    '',
    '你的任务：严格基于提供的编号 Wiki 页面回答用户问题。回答要像一个读过资料、能综合判断的研究助手，而不是把页面内容机械拼接出来。',
    '',
    '## 回答规则',
    '1. 事实依据只能来自“Selected Wiki Pages / Wiki Page Context”中的编号页面；Conversation Context 只用于解析“这个项目/它/上述”等指代，不能作为事实证据。',
    '2. 必须先直接回答问题：第一段用“**结论：** ...”给出核心判断；简单事实问题用 1-3 句话，不要扩写成背景介绍。',
    '3. 回答风格要专业、严谨、内容精炼；避免寒暄、套话、空泛建议、重复背景和“根据资料显示”等无信息量表述。',
    '4. 每个关键事实、数字、判断后尽量用 [1] [2] 这种页码引用。不要引用没有实际使用的页面。',
    '5. 不要补编页面没有明示的信息。不得自行添加目标客群、坪效、价格、运营策略、市场判断、建议动作等新事实；除非用户明确要求推断，且必须标注为“谨慎推断”。',
    '6. 用清晰的 Markdown：短段落、编号列表；只有当信息确实需要比较或矩阵时才使用表格，避免为了形式而拉长答案。',
    '7. 对“商业模式”类问题，优先覆盖：一句话模式、核心业务模块、收入/利润来源、协同机制、关键指标、待验证事项；页面没有的信息用“当前 Wiki 不能确认”。',
    '8. 对“风险/注意事项/未来运营”类问题，优先覆盖：风险类别、风险点、影响、紧迫性、建议动作；页面没有的信息不要扩写。',
    '9. 明确区分“页面中已有事实”和“基于事实的谨慎推断”。不确定时说“当前 Wiki 页面还不能确认”，并指出缺少哪类信息。',
    '10. 长度控制：查询型问题不超过 120 中文字；开放性问题通常不超过 600 中文字，除非用户要求详细报告。',
    '11. 不输出 <think>、思考过程、JSON、代码围栏或额外说明。',
    '12. 结尾必须追加一个 HTML 注释，格式固定为 <!-- cited: 1,2 -->，只列出真正用到的页面编号。',
    '',
    `## User Question\n${payload.question.trim()}`,
    '',
    queryUnderstanding,
    '',
    conversationContext,
    '',
    payload.indexSummary.trim() ? `## Relevant Index Snapshot\n${payload.indexSummary.trim()}` : '',
    '',
    pageList ? `## Selected Wiki Pages\n${pageList}` : '',
    '',
    structuredSupport,
    '',
    '## Wiki Page Context',
    pageBlocks || '(No wiki pages selected)',
  ]
    .filter(Boolean)
    .join('\n');
}

export function normalizeQueryAnswerResponse(
  rawText: string,
  fallbackAnswer: string,
): Pick<QueryAnswerResponse, 'answer' | 'citedIndices'> {
  const text = stripModelReasoning(rawText)
    .replace(/```(?:markdown|text)?/gi, '')
    .replace(/```/g, '')
    .trim();
  const matches = [...text.matchAll(citedPattern)];
  const citedIndicesFromComment = matches.flatMap((match) => parseCitedIndexList(match[1] ?? ''));
  const citedIndices =
    citedIndicesFromComment.length > 0
      ? uniqueNumbers(citedIndicesFromComment)
      : uniqueNumbers([...text.matchAll(/\[(\d{1,3})\]/g)].map((match) => Number.parseInt(match[1] ?? '', 10)));
  const answer = text.replace(citedPattern, '').trim() || fallbackAnswer.trim();
  return {
    answer,
    citedIndices,
  };
}

function buildConversationContextBlock(context: QueryAnswerRequest['conversationContext']) {
  if (!context?.length) return '';
  const lines = context.slice(-6).map((message, index) => {
    const role = message.role === 'user' ? 'User' : 'Assistant';
    const refs = message.references?.length
      ? `\nReferences: ${message.references.map((reference) => reference.title).join('、')}`
      : '';
    return `### Turn ${index + 1} - ${role}\n${compactContextText(message.content)}${refs}`;
  });

  return [
    '## Conversation Context (for resolving follow-up references only)',
    'Use this block only to resolve pronouns or omitted subjects in the current question. Do not cite it and do not treat it as evidence.',
    ...lines,
  ].join('\n\n');
}

function compactContextText(value: string, maxLength = 900) {
  const text = stripModelReasoning(value)
    .replace(citedPattern, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function stripModelReasoning(value: string) {
  return value
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/gi, '')
    .trim();
}

function parseCitedIndexList(value: string) {
  return value
    .split(/[,，、\s]+/)
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((index) => Number.isFinite(index) && index > 0);
}

function uniqueNumbers(values: number[]) {
  return Array.from(new Set(values.filter((value) => Number.isFinite(value) && value > 0)));
}
