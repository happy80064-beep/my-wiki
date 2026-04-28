import type { EntrySource } from '@/types';
import { createEntity, createEntry, createRelationship, createTask, updateEntry } from '@/lib/db';
import { defaultEntityProperties } from '@/lib/db/entities';
import type { CaptureDraft } from './draft';
import { getDraftEntities } from './draft';

export async function persistCaptureDraft(content: string, draft: CaptureDraft, source: EntrySource = 'text') {
  const entry = await createEntry({ content, source, processed: true });
  const entityIdByClientId = new Map<string, string>();

  const entities = [];
  const relationships = [];
  const tasks = [];

  for (const draftEntity of getDraftEntities(draft)) {
    const entity = await createEntity({
      type: draftEntity.type,
      title: draftEntity.title,
      summary: draftEntity.summary,
      tags: draftEntity.tags,
      scenes: draftEntity.scenes,
      properties: defaultEntityProperties(draftEntity.type),
      sourceEntries: [entry.id],
    });
    entityIdByClientId.set(draftEntity.clientId, entity.id);
    entities.push(entity);
  }

  for (const draftRelationship of draft.relationships) {
    const from = entityIdByClientId.get(draftRelationship.fromClientId);
    const to = entityIdByClientId.get(draftRelationship.toClientId);
    if (!from || !to) continue;

    relationships.push(
      await createRelationship({
        from,
        to,
        type: draftRelationship.type,
        evidence: [entry.id],
      }),
    );
  }

  for (const draftTask of draft.tasks) {
    const owner = entityIdByClientId.get(draftTask.ownerClientId);
    if (!owner) continue;

    tasks.push(
      await createTask({
        description: draftTask.description,
        owner,
        linkedTo: draftTask.linkedToClientIds
          .map((clientId) => entityIdByClientId.get(clientId))
          .filter((id): id is string => Boolean(id)),
        dueDate: draftTask.dueDate,
        status: draftTask.status,
        source: entry.id,
      }),
    );
  }

  await updateEntry(entry.id, {
    derivedEntities: entities.map((entity) => entity.id),
    derivedRelationships: relationships.map((relationship) => relationship.id),
    derivedTasks: tasks.map((task) => task.id),
  });

  return {
    entry: (await updateEntry(entry.id, {}))!,
    entities,
    relationships,
    tasks,
  };
}
