import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEntity, createEntry, createRelationship, createTask, resetDatabase } from '@/lib/db';
import { runStructuredQuery } from '@/lib/graph';

describe('structured query', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('reads the entity document for name questions instead of only listing candidates', async () => {
    const entry = await createEntry({
      content: '“桌面数字生命体”是一个运行在 Windows 桌面的 AI 生命体原型，当前角色名为 Serina / 赛琳娜。',
      source: 'text',
    });
    const project = await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '一个具备形象、语音、情绪、任务执行和桌面陪伴能力的本地桌面智能体。',
      sourceEntries: [entry.id],
    });
    const voice = await createEntity({ type: 'topic', title: 'SenseVoice-Small' });
    await createRelationship({ from: project.id, to: voice.id, type: 'depends-on', evidence: [entry.id] });

    const result = await runStructuredQuery('桌面生命体叫什么');

    expect(result.answer).toContain('桌面数字生命体');
    expect(result.answer).toContain('Serina / 赛琳娜');
    expect(result.answer).not.toContain('找到 1 条可能相关的实体');
    expect(result.sources.some((source) => source.type === 'entry' && source.id === entry.id)).toBe(true);
    expect(result.trace?.some((step) => step.layer === 'entity')).toBe(true);
    expect(result.trace?.some((step) => step.layer === 'graph')).toBe(true);
  });

  it('answers general entity profile questions with summary, graph, and evidence', async () => {
    const entry = await createEntry({
      content: '桌面数字生命体已经具备语音交互、联网搜索、任务规划和网页执行能力。',
      source: 'text',
    });
    const project = await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '从会聊天的桌宠进化到具备任务规划和网页执行能力的桌面智能体原型。',
      sourceEntries: [entry.id],
    });
    const openCli = await createEntity({ type: 'topic', title: 'OpenCLI' });
    await createRelationship({ from: project.id, to: openCli.id, type: 'depends-on', evidence: [entry.id] });

    const result = await runStructuredQuery('桌面生命体是什么');

    expect(result.answer).toContain('桌面数字生命体');
    expect(result.answer).toContain('桌面智能体原型');
    expect(result.answer).toContain('OpenCLI');
    expect(result.sources.some((source) => source.id === entry.id)).toBe(true);
  });

  it('uses the LLM expression layer when requested', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({
          answer: '赛琳娜是桌面数字生命体项目里的角色名，用来代表这个具备语音和情绪能力的桌面智能体。',
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )),
    );

    const entry = await createEntry({
      content: '当前角色名为 Serina / 赛琳娜，是桌面数字生命体的拟人形象。',
      source: 'text',
    });
    await createEntity({
      type: 'topic',
      title: 'Serina/赛琳娜',
      summary: '项目的角色名，一个具备拟人音色和情绪的桌面数字生命体形象。',
      sourceEntries: [entry.id],
    });

    const result = await runStructuredQuery('赛琳娜是谁', { composeWithLlm: true });

    expect(result.answer).toContain('赛琳娜是桌面数字生命体项目里的角色名');
    expect(result.llm?.provider).toBe('deepseek');
    expect(result.trace?.some((step) => step.layer === 'answer' && step.label === 'LLM 表达')).toBe(true);
  });

  it('falls back to the structured answer when LLM expression fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'busy' }), { status: 502 })),
    );

    const entry = await createEntry({
      content: '桌面数字生命体是一个运行在 Windows 桌面的 AI 生命体原型。',
      source: 'text',
    });
    await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '运行在 Windows 桌面的 AI 生命体原型。',
      sourceEntries: [entry.id],
    });

    const result = await runStructuredQuery('桌面生命体是什么', { composeWithLlm: true });

    expect(result.answer).toContain('桌面数字生命体');
    expect(result.llm).toBeUndefined();
    expect(result.trace?.some((step) => step.detail.includes('模型表达失败'))).toBe(true);
  });

  it('does not fabricate when no records match', async () => {
    const result = await runStructuredQuery('不存在项目下一阶段有哪些需要优化的');

    expect(result.answer).toContain('没有找到');
    expect(result.sources).toEqual([]);
  });
});
