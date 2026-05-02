import { db } from '@/lib/db';
import { createId } from '@/lib/db/ids';
import type { StructuredQueryResult } from '@/lib/graph';
import { createIngestJob } from '@/lib/ingest';
import type { Entity, Entry, Relationship } from '@/types';

export type SavedQueryInsight = {
  entry: Entry;
  entity: Entity;
  relationships: Relationship[];
  reused: boolean;
  recompileJobId?: string;
};

export async function saveQueryInsight(question: string, result: StructuredQueryResult): Promise<SavedQueryInsight> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    throw new Error('question is required.');
  }
  if (!result.answer.trim()) {
    throw new Error('answer is required.');
  }

  const saved = await db.transaction('rw', [db.entries, db.entities, db.relationships], async () => {
    const now = Date.now();
    const relatedEntityIds = getRelatedEntityIds(result);
    const title = buildInsightTitle(trimmedQuestion);
    const existing = await findExistingInsightEntity(trimmedQuestion);
    const entry: Entry = {
      id: createId('entry'),
      content: buildInsightEntryContent(trimmedQuestion, result),
      source: 'text',
      capturedAt: now,
      processed: true,
      derivedEntities: [],
      derivedTasks: [],
      derivedRelationships: [],
    };
    await db.entries.add(entry);

    const entity =
      existing ??
      ({
        id: createId('topic'),
        type: 'topic',
        title,
        summary: summarizeAnswer(result.answer),
        tags: ['query-insight', `question:${normalizeQuestion(trimmedQuestion)}`],
        scenes: ['work'],
        properties: {
          isPersonal: true,
          myView: result.answer,
          viewHistory: [],
          autoCollectedSnippets: [entry.id],
        },
        sourceEntries: [entry.id],
        createdAt: now,
        updatedAt: now,
      } satisfies Entity);

    if (existing) {
      const properties = existing.properties as Entity['properties'] & {
        autoCollectedSnippets?: string[];
        myView?: string;
        viewHistory?: { view: string; updatedAt: number }[];
      };
      await db.entities.update(existing.id, {
        summary: summarizeAnswer(result.answer),
        sourceEntries: uniqueStrings([...existing.sourceEntries, entry.id]),
        properties: {
          ...properties,
          myView: result.answer,
          viewHistory: properties.myView
            ? [...(properties.viewHistory ?? []), { view: properties.myView, updatedAt: now }]
            : properties.viewHistory ?? [],
          autoCollectedSnippets: uniqueStrings([...(properties.autoCollectedSnippets ?? []), entry.id]),
        },
        updatedAt: now,
      });
    } else {
      await db.entities.add(entity);
    }

    const relationships: Relationship[] = [];
    for (const targetId of relatedEntityIds.filter((id) => id !== entity.id)) {
      const existingRelationship = await db.relationships
        .filter((relationship) => relationship.from === entity.id && relationship.to === targetId && relationship.type === 'about')
        .first();
      if (existingRelationship) {
        await db.relationships.update(existingRelationship.id, {
          evidence: uniqueStrings([...existingRelationship.evidence, entry.id]),
        });
        relationships.push({ ...existingRelationship, evidence: uniqueStrings([...existingRelationship.evidence, entry.id]) });
        continue;
      }

      const relationship: Relationship = {
        id: createId('rel'),
        from: entity.id,
        to: targetId,
        type: 'about',
        evidence: [entry.id],
        createdAt: now,
      };
      await db.relationships.add(relationship);
      relationships.push(relationship);
    }

    await db.entries.update(entry.id, {
      derivedEntities: uniqueStrings([entity.id, ...relatedEntityIds]),
      derivedRelationships: relationships.map((relationship) => relationship.id),
    });

    return {
      entry: {
        ...entry,
        derivedEntities: uniqueStrings([entity.id, ...relatedEntityIds]),
        derivedRelationships: relationships.map((relationship) => relationship.id),
      },
      entity: existing ? { ...existing, sourceEntries: uniqueStrings([...existing.sourceEntries, entry.id]) } : entity,
      relationships,
      reused: Boolean(existing),
    };
  });

  try {
    const job = await createIngestJob({
      content: saved.entry.content,
      source: 'text',
      filename: `query-insight-${saved.entry.id}.md`,
    });
    return { ...saved, recompileJobId: job.id };
  } catch {
    return saved;
  }
}

function getRelatedEntityIds(result: StructuredQueryResult) {
  return uniqueStrings([
    ...(result.candidates ?? []).map((entity) => entity.id),
    ...result.sources.filter((source) => source.type === 'entity').map((source) => source.id),
  ]);
}

function buildInsightTitle(question: string) {
  return `查询洞察：${question.length > 24 ? `${question.slice(0, 23)}...` : question}`;
}

function buildInsightEntryContent(question: string, result: StructuredQueryResult) {
  const sourceLines = result.sources
    .slice(0, 12)
    .map((source) => `- ${source.type}: ${source.title}`)
    .join('\n');

  return [
    '# 查询洞察',
    '',
    `问题：${question}`,
    '',
    '答案：',
    result.answer.trim(),
    '',
    sourceLines ? `来源：\n${sourceLines}` : '来源：暂无结构化来源。',
  ].join('\n');
}

async function findExistingInsightEntity(question: string) {
  const tag = `question:${normalizeQuestion(question)}`;
  return db.entities
    .where('tags')
    .equals(tag)
    .first();
}

function summarizeAnswer(answer: string) {
  const compact = answer.replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? `${compact.slice(0, 119)}...` : compact;
}

function normalizeQuestion(question: string) {
  return question
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
    .slice(0, 80);
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
