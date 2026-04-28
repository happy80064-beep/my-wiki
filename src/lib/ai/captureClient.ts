import type { CaptureDraft } from '../capture/draft';

export type ExtractCaptureResult = {
  draft: CaptureDraft;
  provider: 'minimax' | 'deepseek';
  model: string;
  fallbackFrom?: string;
};

export async function extractCaptureDraft(content: string): Promise<ExtractCaptureResult> {
  const response = await fetch('/api/capture/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  const payload = (await response.json()) as ExtractCaptureResult | { error?: string };
  if (!response.ok || !('draft' in payload)) {
    throw new Error((payload as { error?: string }).error || 'AI 提取失败');
  }

  return payload;
}
