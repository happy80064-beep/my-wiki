import { describe, expect, it } from 'vitest';
import type { Entity } from '@/types';
import { buildBrowserWikiCompileContext } from '../browserCompileContext';

describe('browser wiki compile context', () => {
  it('uses the active workspace schema when building runtime type groups', () => {
    const schema = [
      '# Wiki Schema',
      '',
      '## Page Types',
      '| Type | Directory | Purpose |',
      '|---|---|---|',
      '| goal | wiki/goals/ | Concrete outcomes being pursued. |',
      '| habit | wiki/habits/ | Repeatable behaviors to track. |',
      '| source | wiki/sources/ | Source documents. |',
    ].join('\n');
    const entity = {
      id: 'entity_goal_1',
      clientId: 'client_entity_goal_1',
      type: 'topic',
      title: 'Run 5km',
      summary: 'Current training outcome.',
      tags: ['goal'],
      scenes: ['personal'],
      properties: { isPersonal: true, autoCollectedSnippets: [] },
      sourceEntries: [],
      createdAt: 1,
      updatedAt: 2,
    } as Entity;

    const context = buildBrowserWikiCompileContext({
      entities: [entity],
      entries: [],
      relationships: [],
      workspaceContext: {
        purpose: 'Personal growth wiki.',
        schema,
      },
    });

    expect(context.schema).toBe(schema);
    expect(context.index).toContain('## goal');
    expect(context.index).toContain('[[goals/run-5km|Run 5km]]');
  });
});
