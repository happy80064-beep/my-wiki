import type { QueryIndexEntity, QueryPlan } from './queryPlanner';

export async function planQueryWithAgent(question: string, index: QueryIndexEntity[]): Promise<QueryPlan> {
  const response = await fetch('/api/query/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, index }),
  });

  const body = (await response.json()) as QueryPlan | { error?: string };
  if (!response.ok || !('intent' in body)) {
    throw new Error((body as { error?: string }).error || 'Query Agent 规划失败');
  }

  return body;
}
