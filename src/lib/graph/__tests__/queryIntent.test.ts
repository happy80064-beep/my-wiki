import { describe, expect, it } from 'vitest';
import { parseQueryIntent } from '@/lib/graph';

describe('query intent parser', () => {
  it('detects project improvement questions', () => {
    const intent = parseQueryIntent('桌面生命体下一阶段有哪些需要优化的');

    expect(intent.type).toBe('project_improvements');
    expect(intent.entityName).toBe('桌面生命体');
  });

  it('detects my pending task questions', () => {
    const intent = parseQueryIntent('我有什么待办');

    expect(intent.type).toBe('my_pending_tasks');
    expect(intent.entityName).toBe('我');
  });

  it('detects person pending task questions', () => {
    const intent = parseQueryIntent('虾总有什么没完成的任务');

    expect(intent.type).toBe('person_pending_tasks');
    expect(intent.entityName).toBe('虾总');
  });

  it('detects related technology questions', () => {
    const intent = parseQueryIntent('桌面生命体用了哪些工具和模型');

    expect(intent.type).toBe('project_related_entities');
    expect(intent.entityName).toBe('桌面生命体');
  });
});
