import { beforeEach, describe, expect, it } from 'vitest';
import { createEntity, createEntry, createRelationship, createTask, resetDatabase } from '@/lib/db';
import { runStructuredQuery } from '@/lib/graph';

describe('structured query', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('answers pending tasks by exact owner id', async () => {
    const entry = await createEntry({ content: '任务归属测试', source: 'text' });
    const owner = await createEntity({ type: 'person', title: '虾总' });
    const other = await createEntity({ type: 'person', title: '张总' });

    await createTask({ description: '调通飞书推送', owner: owner.id, source: entry.id });
    await createTask({ description: '不应该出现的任务', owner: other.id, source: entry.id });

    const result = await runStructuredQuery('虾总有什么没完成的任务');

    expect(result.answer).toContain('调通飞书推送');
    expect(result.answer).not.toContain('不应该出现的任务');
    expect(result.sources.some((source) => source.id === owner.id)).toBe(true);
  });

  it('answers my pending tasks by the implicit self entity', async () => {
    const entry = await createEntry({ content: '短期优先级：稳住语音交互主链。', source: 'text' });
    const me = await createEntity({ type: 'person', title: '我' });
    const other = await createEntity({ type: 'person', title: '小林' });

    await createTask({ description: '稳住语音交互主链', owner: me.id, source: entry.id });
    await createTask({ description: '不属于我的任务', owner: other.id, source: entry.id });

    const result = await runStructuredQuery('我有什么待办');

    expect(result.answer).toContain('稳住语音交互主链');
    expect(result.answer).not.toContain('不属于我的任务');
  });

  it('answers project improvement questions through project linked tasks', async () => {
    const entry = await createEntry({
      content: '推荐后续路线：1. 稳住语音交互主链。2. 完善任务规划器。',
      source: 'text',
    });
    const me = await createEntity({ type: 'person', title: '我' });
    const project = await createEntity({ type: 'project', title: '桌面数字生命体', sourceEntries: [entry.id] });
    const unrelated = await createEntity({ type: 'project', title: '股票监控' });

    await createTask({ description: '稳住语音交互主链', owner: me.id, linkedTo: [project.id], source: entry.id });
    await createTask({ description: '完善任务规划器', owner: me.id, linkedTo: [project.id], source: entry.id });
    await createTask({ description: '不应出现的项目任务', owner: me.id, linkedTo: [unrelated.id], source: entry.id });

    const result = await runStructuredQuery('桌面生命体下一阶段有哪些需要优化的');

    expect(result.answer).toContain('桌面数字生命体');
    expect(result.answer).toContain('稳住语音交互主链');
    expect(result.answer).toContain('完善任务规划器');
    expect(result.answer).not.toContain('不应出现的项目任务');
    expect(result.sources.some((source) => source.type === 'entry' && source.id === entry.id)).toBe(true);
  });

  it('answers current project issue questions with linked open tasks', async () => {
    const entry = await createEntry({ content: '当前重点问题：唤醒词仍然不够灵敏。', source: 'text' });
    const me = await createEntity({ type: 'person', title: '我' });
    const project = await createEntity({ type: 'project', title: '桌面数字生命体' });

    await createTask({ description: '优化唤醒词稳定性', owner: me.id, linkedTo: [project.id], source: entry.id });

    const result = await runStructuredQuery('桌面数字生命体当前重点问题是什么');

    expect(result.answer).toContain('优化唤醒词稳定性');
  });

  it('answers project related entity questions from graph relationships', async () => {
    const entry = await createEntry({ content: '项目使用 Gemini、OpenCLI 和 SenseVoice-Small。', source: 'text' });
    const project = await createEntity({ type: 'project', title: '桌面数字生命体' });
    const gemini = await createEntity({ type: 'topic', title: 'Gemini' });
    const openCli = await createEntity({ type: 'topic', title: 'OpenCLI' });
    const senseVoice = await createEntity({ type: 'topic', title: 'SenseVoice-Small' });

    await createRelationship({ from: project.id, to: gemini.id, type: 'depends-on', evidence: [entry.id] });
    await createRelationship({ from: project.id, to: openCli.id, type: 'depends-on', evidence: [entry.id] });
    await createRelationship({ from: project.id, to: senseVoice.id, type: 'depends-on', evidence: [entry.id] });

    const result = await runStructuredQuery('桌面生命体用了哪些工具');

    expect(result.answer).toContain('Gemini');
    expect(result.answer).toContain('OpenCLI');
    expect(result.answer).toContain('SenseVoice-Small');
    expect(result.sources.some((source) => source.id === project.id)).toBe(true);
  });

  it('does not fabricate when no records match', async () => {
    const result = await runStructuredQuery('不存在项目下一阶段有哪些需要优化的');

    expect(result.answer).toContain('没有找到');
    expect(result.sources).toEqual([]);
  });
});
