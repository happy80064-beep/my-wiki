export type MetricScope = 'residential' | 'medical' | 'eldercare' | 'research' | 'cultureTourism';

export const metricScopeTerms: Record<MetricScope, string[]> = {
  residential: ['住宅', '住宅业态', '住宅项目', '宅地', '居住', '住区', '适老住宅'],
  medical: ['医疗', '医疗业态', '医疗板块', '医养', '诊疗', '医院', '门诊', '疗法', '细胞治疗'],
  eldercare: ['康养', '养老', '养生', '康复', '护理', '照护'],
  research: ['研发', '科研', '实验室', '创新中心'],
  cultureTourism: ['文旅', '旅游', '旅居', '消费场景'],
};

export const metricScopeLabels: Record<MetricScope, string> = {
  residential: '住宅业态',
  medical: '医疗业态',
  eldercare: '康养业态',
  research: '研发业态',
  cultureTourism: '文旅业态',
};

export const dimensionSuffixPattern = /(业态|版块|板块|业务线|子分类|子类)$/g;
export const dimensionMentionPattern = /(业态|版块|板块|业务线|子分类|子类)/;
export const listQuestionPattern = /(有哪些|都有哪些|包含哪些|包括哪些|列出|清单)/;
export const listTargetPattern = /(项目|服务|产品|机构|科室|门诊|中心|疗法)/;

export function isMetricQuestion(question: string) {
  return /(指标|收入|营收|金额|费用|成本|投资|利润|价格|总额|面积|规模|人数|数量|年均|合计|多少|几多|多少钱)/.test(question);
}

export function inferMetricScopes(text: string): MetricScope[] {
  const normalized = normalizeLanguageTerm(text);
  return (Object.entries(metricScopeTerms) as Array<[MetricScope, string[]]>)
    .map(([scope, terms]) => {
      const indexes = terms
        .map((term) => normalized.indexOf(normalizeLanguageTerm(term)))
        .filter((index) => index >= 0);
      return indexes.length > 0 ? { scope, index: Math.min(...indexes) } : undefined;
    })
    .filter((item): item is { scope: MetricScope; index: number } => Boolean(item))
    .sort((left, right) => left.index - right.index)
    .map((item) => item.scope);
}

export function inferMetricScope(text: string): MetricScope | undefined {
  return inferMetricScopes(text)[0];
}

export function normalizeLanguageTerm(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
    .trim();
}

export function cjkBigrams(value: string) {
  const cjkText = value.replace(/[^\u4e00-\u9fa5]/g, '');
  if (cjkText.length < 4) return [];

  const grams: string[] = [];
  for (let index = 0; index < cjkText.length - 1; index += 1) {
    grams.push(cjkText.slice(index, index + 2));
  }
  return grams;
}

export function buildAttributeTerms(question: string) {
  const terms: string[] = [];
  const normalized = question.toLowerCase();
  if (/(wake|唤醒|叫醒|kws)/i.test(normalized)) terms.push('唤醒词', '叫醒词', 'KWS', '主唤醒词');
  if (/(stop|终止|停止|打断|miki|mi ki|米基|米奇)/i.test(normalized)) {
    terms.push('终止词', '停止词', '打断词', 'miki', 'mi ki', '米基', '米奇');
  }
  if (/(api\s*key|apikey|密钥|token)/i.test(normalized)) terms.push('API key', '密钥', 'token');
  if (/(模型|model|llm|gemini|minimax|deepseek)/i.test(normalized)) terms.push('模型', 'LLM', 'Gemini', 'MiniMax', 'DeepSeek');
  if (/(路径|目录|文件夹|本地项目)/.test(normalized)) terms.push('路径', '目录', '本地项目路径');
  if (/(负责人|owner|谁负责|归谁)/i.test(normalized)) terms.push('负责人', 'owner');
  if (/(windows|运行环境|桌面环境|操作系统|平台|能否.*运行|是否.*运行|运行在)/i.test(normalized)) {
    terms.push('Windows', '运行环境', '桌面环境', '操作系统', '平台');
  }
  if (/(开源|open\s*source|opensource)/i.test(normalized)) terms.push('开源', 'open source', '开源项目');
  if (/(基于|来源|源自|衍生|二次开发|derived|fork)/i.test(normalized)) {
    terms.push('基于', '来源', '源自', '衍生', '二次开发', 'derivedFrom');
  }
  return uniqueLanguageTerms(terms);
}

export function inferAttribute(question: string) {
  if (/(Windows|windows|运行环境|桌面环境|操作系统|平台|能否.*运行|是否.*运行|运行在)/i.test(question)) {
    return 'runtimeEnvironment';
  }
  if (/(唤醒词|叫醒词|唤醒|KWS)/i.test(question)) return 'wakeWord';
  if (/(终止词|停止词|结束词|打断词|miki|mi ki|米基|米奇)/i.test(question)) return 'stopWord';
  if (/(API\s*key|apikey|密钥|token)/i.test(question)) return 'apiKey';
  if (/(路径|目录|文件夹|本地项目)/.test(question)) return 'localPath';
  if (/(基于|来源|源自|衍生|二次开发|derived|fork)/i.test(question)) return 'derivedFrom';
  if (/(开源项目|开源|open\s*source)/i.test(question)) return 'openSourceStatus';
  if (/(负责人|owner|谁负责|归谁)/i.test(question)) return 'owner';
  return undefined;
}

function uniqueLanguageTerms(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const trimmed = value.trim();
    const key = normalizeLanguageTerm(trimmed);
    if (!trimmed || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
