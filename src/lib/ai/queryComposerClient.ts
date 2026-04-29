import type { QueryComposePayload, QueryComposeResult } from './queryComposer';

export async function composeQueryAnswer(payload: QueryComposePayload): Promise<QueryComposeResult> {
  const response = await fetch('/api/query/compose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = (await response.json()) as QueryComposeResult | { error?: string };
  if (!response.ok || !('answer' in body)) {
    throw new Error((body as { error?: string }).error || '查询表达优化失败');
  }

  return body;
}
