import { describe, expect, it } from 'vitest';
import { inferWikiTargetSpecFromSchema, parseWikiSchemaPageTypes } from '../schemaRules';

describe('schema-driven wiki page rules', () => {
  const schema = [
    '# Wiki Schema',
    '',
    '## Page Types',
    '',
    '| Type | Directory | Purpose |',
    '|------|-----------|---------|',
    '| project | wiki/projects/ | 项目、业务或长期事项 |',
    '| source | wiki/sources/ | 来源说明 |',
    '| concept | wiki/concepts/ | 概念和机制 |',
    '| query | wiki/queries/ | 查询问题 |',
  ].join('\n');

  it('parses Page Types from schema.md', () => {
    expect(parseWikiSchemaPageTypes(schema)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'project', directory: 'wiki/projects/' }),
        expect.objectContaining({ type: 'source', directory: 'wiki/sources/' }),
      ]),
    );
  });

  it('routes project entities to the schema project directory', () => {
    expect(
      inferWikiTargetSpecFromSchema(
        {
          id: 'project_1',
          type: 'project',
          title: '福瑞健康科技园三期项目',
          tags: [],
        },
        { schema },
      ),
    ).toMatchObject({
      type: 'project',
      path: 'wiki/projects/福瑞健康科技园三期项目.md',
    });
  });

  it('honors explicit schema type tags when available', () => {
    expect(
      inferWikiTargetSpecFromSchema(
        {
          id: 'topic_1',
          type: 'topic',
          title: '商业计划书综合判断',
          tags: ['synthesis'],
        },
        { schema: `${schema}\n| synthesis | wiki/synthesis/ | 综合判断 |` },
      ),
    ).toMatchObject({
      type: 'synthesis',
      path: 'wiki/synthesis/商业计划书综合判断.md',
    });
  });
});
