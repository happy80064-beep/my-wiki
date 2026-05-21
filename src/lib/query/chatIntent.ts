export type QueryChatIntentKind = 'none' | 'greeting' | 'thanks' | 'assistant_meta' | 'open_chat' | 'external_realtime';

export type QueryChatIntent = {
  isChat: boolean;
  kind: QueryChatIntentKind;
  label: string;
  confidence: number;
};

const greetingPattern = /^(你好|您好|嗨|哈喽|hello|hi|hey|早上好|上午好|中午好|下午好|晚上好|在吗|在不在)$/i;
const thanksPattern = /^(谢谢|感谢|多谢|辛苦了|麻烦你了|thank\s*you|thanks|thx)$/i;
const assistantMetaPattern =
  /^(你是谁|你是什么|介绍一下你自己|你能做什么|你可以做什么|你会做什么|你有什么功能|怎么称呼你|你叫(什么|啥)|help|what can you do)$/i;
const openChatPattern = /^(随便聊聊|陪我聊聊|我们聊聊|我想闲聊|讲个笑话|说点轻松的)$/i;
const greetingPrefixPattern = /^(你好|您好|嗨|哈喽|hello|hi|hey)[，,。！!\s]+(.+)$/i;
const externalRealtimePattern =
  /(天气|气温|温度|下雨|下雪|空气质量|aqi|新闻|股价|汇率|航班|路况|限行)/i;
const wikiDomainPattern = /(wiki|知识库|资料|材料|文件|页面|词条|图谱|项目|这份|这篇|报告|pdf|word|excel|ppt)/i;
const knowledgeIntentPattern =
  /(wiki|知识库|资料|材料|文件|页面|词条|图谱|项目|这个项目|这份|这篇|报告|pdf|word|excel|ppt|有哪些|是什么|是谁|什么时候|多少|如何|怎么|为什么|分析|总结|对比|风险|建议)/i;

export function detectQueryChatIntent(question: string): QueryChatIntent {
  const trimmed = question.trim();
  if (!trimmed) return buildIntent(false, 'none', '非闲聊', 0);

  const compact = normalizeCasualText(trimmed);
  const prefixed = trimmed.match(greetingPrefixPattern);
  if (isExternalRealtimeIntent(prefixed?.[2]?.trim() || trimmed)) {
    return buildIntent(true, 'external_realtime', '外部实时信息', 0.88);
  }
  if (prefixed?.[2]?.trim() && knowledgeIntentPattern.test(prefixed[2])) {
    return buildIntent(false, 'none', '包含知识库查询意图', 0.78);
  }

  if (greetingPattern.test(compact)) return buildIntent(true, 'greeting', '问候/寒暄', 0.96);
  if (thanksPattern.test(compact)) return buildIntent(true, 'thanks', '感谢/收尾', 0.95);
  if (assistantMetaPattern.test(compact)) return buildIntent(true, 'assistant_meta', '助手能力说明', 0.9);
  if (openChatPattern.test(compact)) return buildIntent(true, 'open_chat', '开放闲聊', 0.86);

  return buildIntent(false, 'none', '知识库查询或开放任务', 0.6);
}

function isExternalRealtimeIntent(value: string) {
  return externalRealtimePattern.test(value) && !wikiDomainPattern.test(value);
}

function buildIntent(
  isChat: boolean,
  kind: QueryChatIntentKind,
  label: string,
  confidence: number,
): QueryChatIntent {
  return { isChat, kind, label, confidence };
}

function normalizeCasualText(value: string) {
  return value
    .trim()
    .replace(/[？?。！!，,、；;：:\s]+$/g, '')
    .replace(/^\s+|\s+$/g, '');
}
