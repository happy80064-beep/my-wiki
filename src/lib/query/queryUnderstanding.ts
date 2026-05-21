export type QueryNeed = 'lookup' | 'open';

export type QueryUnderstandingIntent =
  | 'time_lookup'
  | 'attribute_lookup'
  | 'metric_lookup'
  | 'list_lookup'
  | 'relationship_lookup'
  | 'entity_profile'
  | 'evidence_search'
  | 'open_analysis';

export type QueryUnderstandingAttribute =
  | 'completionDate'
  | 'operationDate'
  | 'startDate'
  | 'runtimeEnvironment'
  | 'wakeWord'
  | 'stopWord'
  | 'localPath'
  | 'openSourceStatus'
  | 'derivedFrom'
  | 'models'
  | 'ownerNote'
  | 'metric';

export type QueryUnderstanding = {
  need: QueryNeed;
  intent: QueryUnderstandingIntent;
  answerStyle: 'direct' | 'brief_list' | 'synthesis';
  answerShape?: 'direct' | 'list' | 'compact_table' | 'analysis';
  attribute?: QueryUnderstandingAttribute;
  evidenceTerms: string[];
  rewrite: string;
  guidance: string[];
  confidence: number;
};

type FieldRule = {
  attribute: QueryUnderstandingAttribute;
  intent: QueryUnderstandingIntent;
  pattern: RegExp;
  terms: string[];
  guidance: string[];
};

const timeRules: FieldRule[] = [
  {
    attribute: 'completionDate',
    intent: 'time_lookup',
    pattern: /(完工|竣工|建成|完成|交付)/,
    terms: ['完工', '竣工', '建成', '完成', '交付', '投入运营', '投运'],
    guidance: [
      '先回答用户问的具体里程碑时间。',
      '如果没有“完工/竣工/建成/完成”的明确日期，但有“投入运营/投运”等相近节点，必须说明它只是相近节点，不能当作完工日期。',
    ],
  },
  {
    attribute: 'operationDate',
    intent: 'time_lookup',
    pattern: /(投入运营|投运|运营|开业|启用)/,
    terms: ['投入运营', '投运', '运营', '开业', '启用'],
    guidance: ['先回答投入运营/投运时间；不要展开项目背景，除非用户追问。'],
  },
  {
    attribute: 'startDate',
    intent: 'time_lookup',
    pattern: /(开工|启动|开建|动工)/,
    terms: ['开工', '启动', '开建', '动工'],
    guidance: ['先回答开工/启动时间；没有明确日期时说明当前 Wiki 未写明。'],
  },
];

const attributeRules: FieldRule[] = [
  {
    attribute: 'runtimeEnvironment',
    intent: 'attribute_lookup',
    pattern: /(windows|macos|linux|运行环境|桌面环境|操作系统|平台|运行在|能否.*运行|是否.*运行)/i,
    terms: ['运行环境', '操作系统', '平台', 'Windows', 'macOS', 'Linux'],
    guidance: ['直接回答运行环境或平台，不要展开实现背景。'],
  },
  {
    attribute: 'wakeWord',
    intent: 'attribute_lookup',
    pattern: /(唤醒词|叫醒词|唤醒|KWS|wake)/i,
    terms: ['唤醒词', '叫醒词', 'KWS', '主唤醒词'],
    guidance: ['直接回答唤醒词；如果材料只有候选词，要明确说是候选而非已确认。'],
  },
  {
    attribute: 'stopWord',
    intent: 'attribute_lookup',
    pattern: /(终止词|停止词|结束词|打断词|miki|mi ki|stop)/i,
    terms: ['终止词', '停止词', '结束词', '打断词', 'miki', 'mi ki'],
    guidance: ['直接回答终止词/停止词；不要把触发机制展开成方案说明。'],
  },
  {
    attribute: 'localPath',
    intent: 'attribute_lookup',
    pattern: /(路径|目录|文件夹|本地项目)/,
    terms: ['路径', '目录', '本地项目路径', '文件夹'],
    guidance: ['直接回答路径或目录；没有明确路径时说当前 Wiki 未写明。'],
  },
  {
    attribute: 'derivedFrom',
    intent: 'attribute_lookup',
    pattern: /(基于|来源于|源自|衍生|二次开发|fork|derived)/i,
    terms: ['基于', '来源于', '源自', '衍生', '二次开发', 'fork', 'derivedFrom'],
    guidance: ['直接回答来源/基于项目；不要把“是否开源”当作来源回答。'],
  },
  {
    attribute: 'openSourceStatus',
    intent: 'attribute_lookup',
    pattern: /(是否开源|是不是开源|开源吗|开源项目|open\s*source|opensource|闭源)/i,
    terms: ['开源', '开源项目', 'open source', '闭源', '非开源'],
    guidance: ['直接回答是否开源；不要和“基于哪个开源项目”混淆。'],
  },
  {
    attribute: 'models',
    intent: 'attribute_lookup',
    pattern: /(模型|model|llm|asr|tts|gemini|minimax|deepseek|glm)/i,
    terms: ['模型', 'LLM', 'ASR', 'TTS', 'Gemini', 'MiniMax', 'DeepSeek', 'GLM'],
    guidance: ['直接列出相关模型；没有明确型号时说明当前 Wiki 未写明。'],
  },
  {
    attribute: 'ownerNote',
    intent: 'attribute_lookup',
    pattern: /(负责人|谁负责|归谁|owner)/i,
    terms: ['负责人', 'owner', '归属'],
    guidance: ['直接回答负责人或归属；不要展开任务背景。'],
  },
];

const metricTerms = ['指标', '收入', '营收', '金额', '费用', '成本', '投资', '利润', '价格', '总额', '面积', '规模', '人数', '数量', '年均', '合计', '多少', '几多', '多少钱'];
const listPattern = /(有哪些|都有哪些|包含哪些|包括哪些|列出|清单)/;
const relationshipPattern = /(关系|关联|相关|依赖|基于|来源|源自|工具|模型|组件|用了哪些|使用哪些|和.+什么关系)/;
const openPattern = /(为什么|如何|怎么做|怎么优化|分析|评价|建议|策略|方案|规划|风险|机会|趋势|影响|优劣|对比|商业模式|未来|可行性|推演|判断)/;
const analyticalTopicPattern = /(商业模式|风险|机会|策略|方案|规划|建议|趋势|影响|优劣|对比|可行性|推演|未来运营|运营风险)/;
const directQuestionPattern = /(什么时候|何时|哪年|几月|日期|时间|多久|多长时间|是否|是不是|能否|能不能|可不可以|多少|几个|哪一个|是什么|是谁|叫什么|叫啥)/;

export function understandQuery(question: string): QueryUnderstanding {
  const trimmed = question.trim();
  const timeRule = timeRules.find((rule) => rule.pattern.test(trimmed));
  if (timeRule && /(什么时候|何时|哪年|几月|日期|时间|多久|多长时间|完工|竣工|建成|完成|投入运营|投运|开工|启动|开建|动工)/.test(trimmed)) {
    return buildUnderstanding(trimmed, timeRule, 'direct', 0.9);
  }

  const attributeRule = attributeRules.find((rule) => rule.pattern.test(trimmed));
  if (attributeRule) {
    return buildUnderstanding(trimmed, attributeRule, 'direct', 0.82);
  }

  if (metricTerms.some((term) => trimmed.includes(term))) {
    return buildUnderstanding(
      trimmed,
      {
        attribute: 'metric',
        intent: 'metric_lookup',
        pattern: /./,
        terms: metricTerms,
        guidance: ['直接回答数值、范围或缺失状态；不要输出项目摘要来替代数值回答。'],
      },
      'direct',
      0.76,
    );
  }

  if (listPattern.test(trimmed)) {
    return {
      need: 'lookup',
      intent: 'list_lookup',
      answerStyle: 'brief_list',
      answerShape: metricTerms.some((term) => trimmed.includes(term)) ? 'compact_table' : 'list',
      evidenceTerms: ['有哪些', '包括', '包含', '清单', '列表'],
      rewrite: rewriteWithTerms(trimmed, ['有哪些', '包括', '包含', '清单']),
      guidance: ['用短列表回答；只列和问题直接相关的项目，不要扩写成背景介绍。'],
      confidence: 0.72,
    };
  }

  if (relationshipPattern.test(trimmed)) {
    return {
      need: directQuestionPattern.test(trimmed) ? 'lookup' : 'open',
      intent: 'relationship_lookup',
      answerStyle: directQuestionPattern.test(trimmed) ? 'direct' : 'synthesis',
      evidenceTerms: ['关系', '关联', '依赖', '基于', '来源', '使用', '模型', '工具', '组件'],
      rewrite: rewriteWithTerms(trimmed, ['关系', '关联', '依赖', '基于', '来源', '使用']),
      guidance: ['优先回答实体之间的直接关系；没有直接关系时说明只能确认的相近关联。'],
      confidence: 0.66,
    };
  }

  if (openPattern.test(trimmed) && (!directQuestionPattern.test(trimmed) || analyticalTopicPattern.test(trimmed))) {
    return {
      need: 'open',
      intent: 'open_analysis',
      answerStyle: 'synthesis',
      answerShape: 'analysis',
      evidenceTerms: [],
      rewrite: trimmed,
      guidance: ['这是开放性问题，需要综合多个 Wiki 页面和证据，不应走简单快查模板。'],
      confidence: 0.7,
    };
  }

  return {
    need: directQuestionPattern.test(trimmed) ? 'lookup' : 'open',
    intent: directQuestionPattern.test(trimmed) ? 'entity_profile' : 'evidence_search',
    answerStyle: directQuestionPattern.test(trimmed) ? 'direct' : 'synthesis',
    answerShape: directQuestionPattern.test(trimmed) ? 'direct' : 'analysis',
    evidenceTerms: [],
    rewrite: trimmed,
    guidance: directQuestionPattern.test(trimmed)
      ? ['先直接回答用户问的事实；不要用页面摘要替代答案。']
      : ['根据 Wiki 证据综合回答。'],
    confidence: 0.55,
  };
}

export function buildLookupRetrievalText(question: string, understanding = understandQuery(question)) {
  if (understanding.need !== 'lookup' || understanding.evidenceTerms.length === 0) return question;
  return rewriteWithTerms(question, understanding.evidenceTerms);
}

export function queryUnderstandingForPrompt(understanding: QueryUnderstanding | undefined) {
  if (!understanding) return '';
  return [
    '## Query Understanding',
    `Need: ${understanding.need}`,
    `Intent: ${understanding.intent}`,
    understanding.attribute ? `Requested field: ${understanding.attribute}` : '',
    `Answer style: ${understanding.answerStyle}`,
    understanding.answerShape ? `Answer shape: ${understanding.answerShape}` : '',
    understanding.evidenceTerms.length ? `Evidence terms: ${understanding.evidenceTerms.join(', ')}` : '',
    understanding.guidance.length ? `Guidance:\n${understanding.guidance.map((item) => `- ${item}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildUnderstanding(
  question: string,
  rule: FieldRule,
  answerStyle: QueryUnderstanding['answerStyle'],
  confidence: number,
): QueryUnderstanding {
  return {
    need: 'lookup',
    intent: rule.intent,
    answerStyle,
    answerShape:
      answerStyle === 'direct'
        ? 'direct'
        : answerStyle === 'brief_list'
          ? 'list'
          : 'analysis',
    attribute: rule.attribute,
    evidenceTerms: rule.terms,
    rewrite: rewriteWithTerms(question, rule.terms),
    guidance: rule.guidance,
    confidence,
  };
}

function rewriteWithTerms(question: string, terms: string[]) {
  const additions = uniqueTerms(terms).filter((term) => !question.includes(term));
  return additions.length ? `${question} ${additions.join(' ')}` : question;
}

function uniqueTerms(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase().replace(/\s+/g, '');
    if (!trimmed || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
