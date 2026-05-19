import type { Entity, WikiReviewRecord, WikiReviewStatus } from '@/types';
import { createWikiMarkdownHash, mergeAiMarkdownWithHumanSuperseded } from '@/lib/wiki/humanEditGuard';
import { buildWikiPageMetadata } from '@/lib/wiki/pageMetadata';
import { extractMarkdownSummary } from '@/lib/wiki/markdownCompiler';
import { db } from './schema';
import { createId } from './ids';
import { getClientId } from './clientId';

export type UpsertWikiReviewInput = {
  type: WikiReviewRecord['type'];
  entity: Entity;
  title: string;
  reason: string;
  currentMarkdown: string;
  proposedMarkdown: string;
  provider?: string;
  model?: string;
  sourceLabel?: string;
};

export function createWikiReviewFingerprint(input: Pick<UpsertWikiReviewInput, 'type' | 'entity' | 'currentMarkdown' | 'proposedMarkdown'>) {
  return [
    input.type,
    input.entity.id,
    createWikiMarkdownHash(input.currentMarkdown),
    createWikiMarkdownHash(input.proposedMarkdown),
  ].join(':');
}

export async function upsertPendingWikiReview(input: UpsertWikiReviewInput) {
  const fingerprint = createWikiReviewFingerprint(input);
  const existing = await db.wikiReviewItems.where('fingerprint').equals(fingerprint).first();
  const now = Date.now();

  if (existing) {
    if (existing.status === 'pending') {
      await db.wikiReviewItems.update(existing.id, {
        title: input.title,
        reason: input.reason,
        currentMarkdown: input.currentMarkdown,
        proposedMarkdown: input.proposedMarkdown,
        provider: input.provider,
        model: input.model,
        sourceLabel: input.sourceLabel,
        updatedAt: now,
      });
      return (await db.wikiReviewItems.get(existing.id)) ?? existing;
    }
    return existing;
  }

  const record: WikiReviewRecord = {
    id: createId('wiki-review'),
    clientId: getClientId(),
    fingerprint,
    type: input.type,
    status: 'pending',
    entityId: input.entity.id,
    entityTitle: input.entity.title,
    title: input.title,
    reason: input.reason,
    currentMarkdown: input.currentMarkdown,
    proposedMarkdown: input.proposedMarkdown,
    provider: input.provider,
    model: input.model,
    sourceLabel: input.sourceLabel,
    createdAt: now,
    updatedAt: now,
  };

  await db.wikiReviewItems.add(record);
  return record;
}

export async function applyWikiReviewItem(id: string) {
  const review = await db.wikiReviewItems.get(id);
  if (!review || review.status !== 'pending') return undefined;

  const entity = await db.entities.get(review.entityId);
  if (!entity) {
    return markWikiReviewItem(id, 'superseded');
  }

  const now = Date.now();
  const merged = mergeAiMarkdownWithHumanSuperseded({
    currentMarkdown: entity.wikiMarkdown ?? review.currentMarkdown,
    proposedMarkdown: review.proposedMarkdown,
    reason: review.reason,
    source: review.sourceLabel,
    now,
  });
  const metadata = buildWikiPageMetadata(merged.markdown, entity);
  const nextTags = metadata.tags.length > 0 ? metadata.tags : entity.tags;

  await db.transaction('rw', db.entities, db.wikiReviewItems, async () => {
    await db.entities.update(entity.id, {
      title: metadata.title || entity.title,
      summary: extractMarkdownSummary(merged.markdown) || metadata.description || entity.summary,
      tags: nextTags,
      wikiMarkdown: merged.markdown,
      wikiCompiledAt: now,
      wikiCompileModel: review.provider && review.model ? `${review.provider}:${review.model}` : entity.wikiCompileModel,
      wikiHumanEditedAt: now,
      wikiHumanEditHash: createWikiMarkdownHash(merged.markdown),
      wikiLastAiMarkdownHash: createWikiMarkdownHash(review.proposedMarkdown),
      updatedAt: now,
    });
    await db.wikiReviewItems.update(review.id, {
      status: 'applied',
      mergedMarkdown: merged.markdown,
      mergeMode: merged.mode,
      appliedAt: now,
      updatedAt: now,
    });
  });

  return db.wikiReviewItems.get(id);
}

export async function dismissWikiReviewItem(id: string) {
  return markWikiReviewItem(id, 'dismissed');
}

export async function markWikiReviewItem(id: string, status: Exclude<WikiReviewStatus, 'pending' | 'applied'>) {
  const now = Date.now();
  await db.wikiReviewItems.update(id, {
    status,
    dismissedAt: status === 'dismissed' ? now : undefined,
    supersededAt: status === 'superseded' ? now : undefined,
    updatedAt: now,
  });
  return db.wikiReviewItems.get(id);
}
