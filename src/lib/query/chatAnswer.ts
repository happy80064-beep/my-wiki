import type { RuntimeProviderTiming } from '@/lib/llm/runtimeProvider';
import type { QueryConversationContextMessage } from './queryAnswer';

export type QueryChatAnswerRequest = {
  question: string;
  intentLabel: string;
  conversationContext?: QueryConversationContextMessage[];
};

export type QueryChatAnswerResponse = {
  answer: string;
  provider: string;
  model: string;
  fallbackFrom?: string;
  llmTiming?: RuntimeProviderTiming;
};

export function buildQueryChatPrompt(payload: QueryChatAnswerRequest) {
  const conversationContext = buildConversationContextBlock(payload.conversationContext);
  return [
    '你是 MyWiki 的中文对话助手。',
    '',
    '这轮问题已被系统识别为闲聊、问候、感谢或询问助手能力，不是知识库检索任务。',
    '',
    '## 回答规则',
    '1. 直接自然地回复用户，保持简短、友好、清楚。',
    '2. 不要声称已经检索 Wiki、资料、页面或网页。',
    '3. 不要编造知识库内容。如果用户想查资料，可以邀请用户问一个具体的知识库问题。',
    '4. 如果 Intent 是外部实时信息，必须说明当前本地 Query 不会检索实时网页或天气服务；不要编造实时天气、股价、新闻等结果，可以建议使用补充/深度研究或外部实时服务。',
    '5. Conversation Context 只能用于理解语气和上下文，不得作为事实证据。',
    '6. 不输出 JSON、代码块、<think> 或思考过程。',
    '',
    `## Intent\n${payload.intentLabel}`,
    '',
    conversationContext,
    '',
    `## User Message\n${payload.question.trim()}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function normalizeQueryChatResponse(rawText: string) {
  return stripModelReasoning(rawText)
    .replace(/```(?:markdown|text)?/gi, '')
    .replace(/```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

function buildConversationContextBlock(context: QueryChatAnswerRequest['conversationContext']) {
  if (!context?.length) return '';
  return [
    '## Conversation Context',
    ...context.slice(-4).map((message, index) => {
      const role = message.role === 'user' ? 'User' : 'Assistant';
      return `### Turn ${index + 1} - ${role}\n${compactContextText(message.content)}`;
    }),
  ].join('\n\n');
}

function compactContextText(value: string, maxLength = 700) {
  const text = stripModelReasoning(value)
    .replace(/<!--[\s\S]*?-->/g, '')
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
