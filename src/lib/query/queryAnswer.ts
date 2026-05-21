import type { RuntimeProviderTiming } from '@/lib/llm/runtimeProvider';
import { classifyQueryMode, queryModeForPrompt, type QueryMode } from './queryMode';
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
  queryMode?: QueryMode;
  workspaceContext?: QueryWorkspaceContext;
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

export type QueryWorkspaceContext = {
  purpose?: string;
  index?: string;
  files?: Array<{
    path: string;
    title: string;
    kind: 'wiki' | 'source';
    excerpt: string;
    score: number;
  }>;
  trace?: string[];
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
  const effectiveQueryMode = payload.queryMode ?? classifyQueryMode(payload.question);
  const queryMode = queryModeForPrompt(effectiveQueryMode);
  const workspaceContext = buildWorkspaceContextBlock(payload.workspaceContext);
  const answerRules = buildAnswerRules(effectiveQueryMode);

  return [
    '你是 MyWiki Query 3.0 的中文 Wiki 对话分析助手。',
    '',
    '你的任务：严格基于提供的编号 Wiki 页面回答用户问题。回答要像一个读过资料、能综合判断的研究助手，而不是把页面内容机械拼接出来。',
    '',
    '## 回答规则',
    ...answerRules,
    '',
    `## User Question\n${payload.question.trim()}`,
    '',
    queryMode,
    '',
    queryUnderstanding,
    '',
    conversationContext,
    '',
    workspaceContext,
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

function buildAnswerRules(mode: QueryMode | undefined) {
  const common = [
    '1. 事实依据只能来自“Selected Wiki Pages / Wiki Page Context”中的编号页面；Workspace Context 只能帮助理解知识库范围和补充候选，不能替代编号页引用。',
    '2. Conversation Context 只用于解析“这个项目/它/上述”等指代，不能作为事实证据。',
    '3. 每个关键事实、数字、判断后尽量用 [1] [2] 这种页码引用。不要引用没有实际使用的页面。',
    '4. 不要补编页面没有明示的信息；需要推断时必须标注为“谨慎推断”，并说明它基于哪些已引用事实。',
    '5. 不输出 <think>、思考过程、JSON、代码围栏或额外说明。',
    '6. 结尾必须追加一个 HTML 注释，格式固定为 <!-- cited: 1,2 -->，只列出真正用到的页面编号。',
    '7. 回答风格要专业、严谨、内容精炼；避免寒暄、套话、空泛建议、重复背景和“根据资料显示”等无信息量表述。',
  ];

  if (!mode || mode.kind === 'lookup') {
    const shapeRule =
      mode?.answerShape === 'list'
        ? '8. 本轮是事实清单查询：用短列表回答，只列和问题直接相关的项目；不要展开成背景介绍。'
        : mode?.answerShape === 'compact_table'
          ? '8. 本轮是指标/对比类事实查询：优先用紧凑表格回答，列名要短；缺失值写“当前 Wiki 不能确认”。'
          : '8. 本轮是单点事实查询：先给 1 句直接答案，必要时再补 1-2 句限定条件。';
    return [
      ...common,
      shapeRule,
      '9. 风格必须简练、直接、可核查；除非用户要求，不给建议、不做延展分析。',
      '10. 长度控制：直接短答通常不超过 120 中文字；清单/表格只保留必要行列。',
    ];
  }

  return [
    ...common,
    '8. 本轮是开放分析或混合查询：先用“**结论：** ...”给出判断，再分层说明证据、风险/机会、建议或待确认事项。',
    '9. 可以使用结构化段落、编号列表或表格；优先提高信息密度和可执行性，不机械压缩成短答。',
    '10. 对“商业模式”类问题，优先覆盖：一句话模式、核心业务模块、收入/利润来源、协同机制、关键指标、待验证事项；页面没有的信息用“当前 Wiki 不能确认”。',
    '11. 对“风险/注意事项/未来运营”类问题，优先覆盖：风险类别、风险点、影响、紧迫性、建议动作；页面没有的信息不要扩写成确定事实。',
    '12. 明确区分“页面中已有事实”和“基于事实的谨慎推断”。不确定时指出缺少哪类信息。',
    '13. 长度控制：通常 600-1200 中文字；用户要求详细报告时可以更长，但仍要紧凑。',
  ];
}

function buildWorkspaceContextBlock(context: QueryWorkspaceContext | undefined) {
  if (!context) return '';
  const sections = [
    context.purpose?.trim() ? `### purpose.md\n${compactContextText(context.purpose, 1800)}` : '',
    context.index?.trim() ? `### wiki/index.md\n${compactContextText(context.index, 2200)}` : '',
    context.files?.length
      ? [
          '### Retrieved Workspace Markdown Candidates',
          ...context.files.slice(0, 8).map((file, index) =>
            [
              `#### W${index + 1}. ${file.title}`,
              `Path: ${file.path}`,
              `Kind: ${file.kind}`,
              `Score: ${Math.round(file.score)}`,
              file.excerpt,
            ].join('\n'),
          ),
        ].join('\n\n')
      : '',
  ].filter(Boolean);
  if (sections.length === 0) return '';
  return [
    '## Workspace Context (scope and candidate material only)',
    'Use this block to understand project scope and possible source candidates. If a fact is not present in a numbered Wiki page, do not cite it as a confirmed answer fact.',
    ...sections,
  ].join('\n\n');
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
