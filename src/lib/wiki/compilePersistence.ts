import { db, upsertPendingWikiReview } from '@/lib/db';
import type { Entity, WikiReviewRecord } from '@/types';
import { createWikiMarkdownHash, shouldQueueHumanEditReview } from './humanEditGuard';
import type { WikiMarkdownCompileResult } from './markdownCompiler';

export type PersistWikiCompileCandidateInput = {
  entity: Entity;
  payload: WikiMarkdownCompileResult;
  provider: string;
  model: string;
  sourceCount: number;
  sourceLabel: string;
};

export type PersistWikiCompileCandidateResult = {
  applied: boolean;
  review?: WikiReviewRecord;
};

export async function persistWikiCompileCandidate(input: PersistWikiCompileCandidateInput): Promise<PersistWikiCompileCandidateResult> {
  const { entity, payload, provider, model, sourceCount, sourceLabel } = input;
  const now = Date.now();

  if (shouldQueueHumanEditReview(entity, payload.markdown)) {
    const review = await upsertPendingWikiReview({
      type: 'human-edit-conflict',
      entity,
      title: `AI update needs review: ${entity.title}`,
      reason: 'AI recompilation differs from human-edited wiki content.',
      currentMarkdown: entity.wikiMarkdown ?? '',
      proposedMarkdown: payload.markdown,
      provider,
      model,
      sourceLabel,
    });
    return { applied: false, review };
  }

  const tags = mergeTags(entity.tags, payload.tags);
  await db.entities.update(entity.id, {
    summary: payload.summary || entity.summary,
    tags,
    wikiMarkdown: payload.markdown,
    wikiCompiledAt: now,
    wikiCompileModel: `${provider}:${model}`,
    wikiLastAiMarkdownHash: createWikiMarkdownHash(payload.markdown),
    compiledProfile: {
      overview: payload.summary || entity.summary,
      keyFacts: [],
      openTasks: [],
      relationshipSummary: [],
      sourceSummary: `${sourceCount} source(s) used for AI wiki compilation.`,
      updatedAt: now,
    },
    updatedAt: now,
  });

  return { applied: true };
}

function mergeTags(existing: string[], incoming: string[]) {
  return Array.from(new Set([...existing, ...incoming].map((tag) => tag.trim()).filter(Boolean))).slice(0, 16);
}
