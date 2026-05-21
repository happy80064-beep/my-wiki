import { detectQueryChatIntent, type QueryChatIntent } from './chatIntent';

export type QueryModeKind = 'chat' | 'lookup' | 'analysis' | 'mixed' | 'uncertain';

export type QueryAnswerShape = 'direct' | 'list' | 'compact_table' | 'analysis';

export type QueryMode = {
  kind: QueryModeKind;
  answerShape: QueryAnswerShape;
  label: string;
  confidence: number;
  chatIntent?: QueryChatIntent;
  reasons: string[];
  retrieval: {
    profile: 'none' | 'precise' | 'balanced' | 'broad' | 'guarded';
    pageLimit: number;
    includeWorkspaceContext: boolean;
    enableGraphExpansion: boolean;
    enableSemanticChunks: boolean;
  };
};

const listPattern = /(有哪些|都有哪些|包含哪些|包括哪些|列出|清单|列表|分别是|分别有哪些)/;
const tablePattern = /(分别多少|各自多少|分别是多少|各.*多少|面积|收入|营收|成本|费用|价格|指标|金额|数量|占比|比例)/;
const directPattern = /(什么时候|何时|哪年|几月|日期|时间|在哪里|哪儿|哪|是谁|是什么|是否|是不是|能否|能不能|多少|几个|哪一个|叫什么|路径|目录|负责人|开源吗|基于什么)/;
const analysisPattern = /(难点|风险|建议|商业模式|可行性|怎么优化|如何优化|为什么|原因|策略|方案|规划|机会|趋势|影响|优劣|对比|判断|推演|未来运营|运营|优先级)/;
const mixedPattern = /(什么时候|何时|多少|有哪些|是什么|是否|分别).*(建议|风险|难点|原因|影响|优化|商业模式|可行性)|(建议|风险|难点|原因|影响|优化|商业模式|可行性).*(什么时候|何时|多少|有哪些|是什么|是否|分别)/;

export function classifyQueryMode(question: string): QueryMode {
  const trimmed = question.trim();
  const chatIntent = detectQueryChatIntent(trimmed);
  if (chatIntent.isChat) {
    return {
      kind: 'chat',
      answerShape: 'direct',
      label: chatIntent.label,
      confidence: chatIntent.confidence,
      chatIntent,
      reasons: ['识别为纯闲聊/问候/能力说明，跳过知识库检索。'],
      retrieval: {
        profile: 'none',
        pageLimit: 0,
        includeWorkspaceContext: false,
        enableGraphExpansion: false,
        enableSemanticChunks: false,
      },
    };
  }

  const reasons: string[] = [];
  const hasAnalysis = analysisPattern.test(trimmed);
  const hasList = listPattern.test(trimmed);
  const hasDirect = directPattern.test(trimmed);
  const hasMixed = mixedPattern.test(trimmed);

  if (hasMixed) {
    reasons.push('同时包含事实核查和分析/建议信号。');
    return buildMode('mixed', 'analysis', '混合查询', 0.78, reasons);
  }

  if (hasAnalysis) {
    reasons.push('包含难点/风险/建议/商业模式/优化等开放分析信号。');
    return buildMode('analysis', 'analysis', '开放分析', 0.76, reasons);
  }

  if (hasList) {
    reasons.push('包含“有哪些/包括哪些/列出”等事实清单信号。');
    return buildMode('lookup', tablePattern.test(trimmed) ? 'compact_table' : 'list', '事实查询', 0.74, reasons);
  }

  if (hasDirect) {
    reasons.push('包含时间、地点、数值、是否、是谁/是什么等单点事实信号。');
    return buildMode('lookup', tablePattern.test(trimmed) ? 'compact_table' : 'direct', '事实查询', 0.72, reasons);
  }

  reasons.push('未命中强事实或强分析信号，按保守扩展处理。');
  return buildMode('uncertain', 'analysis', '意图不确定', 0.5, reasons);
}

export function queryModeForPrompt(mode: QueryMode) {
  return [
    '## Query Mode',
    `Mode: ${mode.kind}`,
    `Answer shape: ${mode.answerShape}`,
    `Retrieval profile: ${mode.retrieval.profile}`,
    `Confidence: ${Math.round(mode.confidence * 100)}%`,
    mode.reasons.length ? `Reasons:\n${mode.reasons.map((reason) => `- ${reason}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function describeQueryMode(mode: QueryMode) {
  const shapeLabel =
    mode.answerShape === 'direct'
      ? '单点短答'
      : mode.answerShape === 'list'
        ? '事实清单'
        : mode.answerShape === 'compact_table'
          ? '紧凑表格'
          : '结构化分析';
  const retrievalLabel =
    mode.retrieval.profile === 'none'
      ? '不检索 Wiki'
      : mode.retrieval.profile === 'precise'
        ? '精准召回'
        : mode.retrieval.profile === 'balanced'
          ? '中等召回'
          : mode.retrieval.profile === 'broad'
            ? '宽召回'
            : '保守扩展';
  return `识别为${mode.label}（${mode.kind} / ${shapeLabel}），置信度 ${Math.round(
    mode.confidence * 100,
  )}%。检索策略：${retrievalLabel}；页面上限 ${mode.retrieval.pageLimit}；${
    mode.retrieval.includeWorkspaceContext ? '会加入工作区 purpose/index 上下文' : '不加入额外工作区上下文'
  }。${mode.reasons.join(' ')}`;
}

function buildMode(
  kind: Exclude<QueryModeKind, 'chat'>,
  answerShape: QueryAnswerShape,
  label: string,
  confidence: number,
  reasons: string[],
): QueryMode {
  if (kind === 'lookup') {
    return {
      kind,
      answerShape,
      label,
      confidence,
      reasons,
      retrieval: {
        profile: answerShape === 'direct' ? 'precise' : 'balanced',
        pageLimit: answerShape === 'direct' ? 8 : 10,
        includeWorkspaceContext: false,
        enableGraphExpansion: answerShape !== 'direct',
        enableSemanticChunks: false,
      },
    };
  }

  if (kind === 'analysis') {
    return {
      kind,
      answerShape,
      label,
      confidence,
      reasons,
      retrieval: {
        profile: 'broad',
        pageLimit: 14,
        includeWorkspaceContext: true,
        enableGraphExpansion: true,
        enableSemanticChunks: true,
      },
    };
  }

  if (kind === 'mixed') {
    return {
      kind,
      answerShape,
      label,
      confidence,
      reasons,
      retrieval: {
        profile: 'broad',
        pageLimit: 12,
        includeWorkspaceContext: true,
        enableGraphExpansion: true,
        enableSemanticChunks: true,
      },
    };
  }

  return {
    kind,
    answerShape,
    label,
    confidence,
    reasons,
    retrieval: {
      profile: 'guarded',
      pageLimit: 10,
      includeWorkspaceContext: true,
      enableGraphExpansion: true,
      enableSemanticChunks: false,
    },
  };
}
