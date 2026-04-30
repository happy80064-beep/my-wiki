import type { CaptureDraft } from '../capture/draft';
import { db } from '@/lib/db';

export type ExtractCaptureResult = {
  draft: CaptureDraft;
  provider: 'minimax' | 'deepseek';
  model: string;
  fallbackFrom?: string;
  mode?: 'two-step' | 'single-step';
};

export async function extractCaptureDraft(content: string): Promise<ExtractCaptureResult> {
  const entityIndex = await buildCaptureEntityIndex();
  const response = await fetch('/api/capture/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, entityIndex }),
  });

  const payload = (await response.json()) as ExtractCaptureResult | { error?: string };
  if (!response.ok || !('draft' in payload)) {
    throw new Error((payload as { error?: string }).error || 'AI 提取失败');
  }

  return payload;
}

async function buildCaptureEntityIndex() {
  const entities = await db.entities.orderBy('updatedAt').reverse().limit(120).toArray();
  return entities.map((entity) => ({
    id: entity.id,
    type: entity.type,
    title: entity.title,
    summary: entity.summary,
    tags: entity.tags,
    scenes: entity.scenes,
    sourceCount: entity.sourceEntries.length,
    updatedAt: entity.updatedAt,
  }));
}
