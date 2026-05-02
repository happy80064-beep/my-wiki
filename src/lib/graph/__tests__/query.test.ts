import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCompileSuggestion,
  createEntity,
  createEntry,
  createRelationship,
  createTask,
  db,
  getEntity,
  resetDatabase,
} from '@/lib/db';
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

  it('uses compiled profiles as prebuilt wiki context', async () => {
    const project = await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '桌面智能体原型。',
    });
    await db.entities.update(project.id, {
      compiledProfile: {
        overview: '桌面数字生命体已经预编译为桌面智能体项目综述。',
        keyFacts: ['运行环境：Windows 桌面', '唤醒词：小林'],
        openTasks: ['稳住语音交互主链'],
        relationshipSummary: ['依赖：SenseVoice-Small'],
        sourceSummary: '1 条来源。',
        updatedAt: Date.now(),
      },
    });

    const result = await runStructuredQuery('桌面生命体的唤醒词是什么');

    expect(result.answer).toContain('关键信息');
    expect(result.answer).toContain('唤醒词：小林');
    expect(result.sources.some((source) => source.id === project.id)).toBe(true);
  });

  it('keeps fast wiki-read answers readable instead of dumping raw OCR evidence', async () => {
    const noisyEntry = await createEntry({
      content: [
        '# 导入文件：image.png 来源格式：图片解析',
        '中国 长 寿 诊 疗 机 构 六 型 谱 包 括 老 年 医 学 /CGA 延 伸 型、MDT 抗 衰 专 病 门 诊 型、功 能 医 学 综 合 管 理 型。',
        '>>> 数据来源：数字生命卡兹克公众号文章数据统计',
        '短视频爆款元素汇总：成本元素、金钱相关、情绪强度。',
      ].join('\n'),
      source: 'image',
    });
    await createEntity({
      type: 'topic',
      title: '中国长寿诊疗机构六型谱',
      summary: '中国长寿诊疗机构主要包括老年医学/CGA延伸型、MDT抗衰专病门诊型、功能医学综合管理型等六种类型。',
      sourceEntries: [noisyEntry.id],
    });

    const result = await runStructuredQuery('中国长寿行业都有哪些类型的机构？');

    expect(result.answer).toContain('中国长寿诊疗机构主要包括');
    expect(result.answer).toContain('原始材料命中');
    expect(result.answer).not.toContain('短视频爆款元素');
    expect(result.answer).not.toContain('>>>');
    expect(result.sources.some((source) => source.id === noisyEntry.id)).toBe(true);
  });

  it('expands wiki reads through two-hop graph relevance', async () => {
    const entry = await createEntry({
      content: '桌面数字生命体需要稳定唤醒方案和语音交互主链。',
      source: 'text',
    });
    const project = await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '桌面智能体原型。',
      sourceEntries: [entry.id],
    });
    const voice = await createEntity({
      type: 'topic',
      title: '语音交互',
      summary: '语音输入输出链路。',
      sourceEntries: [entry.id],
    });
    const wake = await createEntity({
      type: 'topic',
      title: '唤醒方案',
      summary: '小林唤醒和 KWS 稳定性方案。',
      sourceEntries: [],
    });

    await createRelationship({ from: project.id, to: voice.id, type: 'relevant-to', evidence: [entry.id] });
    await createRelationship({ from: voice.id, to: wake.id, type: 'related-to', evidence: [entry.id] });

    const result = await runStructuredQuery('桌面生命体是什么');

    expect(result.answer).toContain('语音交互');
    expect(result.answer).toContain('唤醒方案');
    expect(result.trace?.some((step) => step.detail.includes('展开 2 跳关系'))).toBe(true);
  });

  it('answers relationship path questions between two entities', async () => {
    const entry = await createEntry({
      content: '桌面数字生命体需要稳定唤醒方案和语音交互主链。',
      source: 'text',
    });
    const project = await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '桌面智能体原型。',
      sourceEntries: [entry.id],
    });
    const voice = await createEntity({
      type: 'topic',
      title: '语音交互',
      summary: '语音链路。',
      sourceEntries: [entry.id],
    });
    const wake = await createEntity({
      type: 'topic',
      title: '唤醒词',
      summary: '小林唤醒和 KWS 稳定性方案。',
      sourceEntries: [entry.id],
    });

    await createRelationship({ from: project.id, to: voice.id, type: 'relevant-to', evidence: [entry.id] });
    await createRelationship({ from: voice.id, to: wake.id, type: 'related-to', evidence: [entry.id] });

    const result = await runStructuredQuery('桌面生命体和唤醒方案有什么关系');

    expect(result.answer).toContain('桌面数字生命体 和 唤醒词');
    expect(result.answer).toContain('语音交互');
    expect(result.trace?.some((step) => step.label === '路径搜索')).toBe(true);
    expect(result.sources.some((source) => source.id === entry.id)).toBe(true);
  });

  it('falls back to source evidence when a relationship target is not yet an entity', async () => {
    const entry = await createEntry({
      content: '桌面数字生命体需要稳定唤醒方案和语音交互主链，主唤醒词是“小林”。',
      source: 'text',
    });
    await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '桌面智能体原型。',
      sourceEntries: [entry.id],
    });

    const result = await runStructuredQuery('桌面生命体和唤醒方案有什么关系');

    expect(result.answer).toContain('没有找到独立实体「唤醒方案」');
    expect(result.answer).toContain('来源材料');
    expect(result.answer).toContain('唤醒方案');
    expect(result.sources.some((source) => source.id === entry.id)).toBe(true);
    expect(result.trace?.some((step) => step.label === '原始材料兜底扫描')).toBe(true);
    expect(result.compileSuggestions?.[0]).toEqual(
      expect.objectContaining({
        propertyKey: 'wakeWord',
        propertyValue: '小林',
      }),
    );
  });

  it('does not resolve both sides of a relationship question to the same entity', async () => {
    const entry = await createEntry({
      content: '语音链路说明：桌面数字生命体主唤醒词是“小林”，唤醒稳定性仍需优化。',
      source: 'text',
    });
    await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '桌面智能体原型，需要稳定唤醒词和语音交互主链。',
      sourceEntries: [entry.id],
    });

    const result = await runStructuredQuery('桌面生命体和唤醒方案有什么关系');

    expect(result.answer).toContain('没有找到独立实体「唤醒方案」');
    expect(result.answer).not.toContain('桌面数字生命体 和 桌面数字生命体');
    expect(result.trace?.some((step) => step.detail.includes('改为扫描'))).toBe(true);
  });

  it('uses Query Agent planning for relationship path questions', async () => {
    const entry = await createEntry({
      content: '桌面数字生命体通过语音交互链路连接唤醒词，小林是主唤醒词。',
      source: 'text',
    });
    const project = await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '桌面智能体原型。',
      sourceEntries: [entry.id],
    });
    const voice = await createEntity({
      type: 'topic',
      title: '语音交互',
      summary: '语音输入输出链路。',
      sourceEntries: [entry.id],
    });
    const wake = await createEntity({
      type: 'topic',
      title: '唤醒词',
      summary: '小林唤醒和 KWS 稳定性方案。',
      sourceEntries: [entry.id],
    });

    await createRelationship({ from: project.id, to: voice.id, type: 'relevant-to', evidence: [entry.id] });
    await createRelationship({ from: voice.id, to: wake.id, type: 'related-to', evidence: [entry.id] });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({
          intent: 'relationship_lookup',
          selectedEntityIds: [project.id, wake.id],
          entityCandidates: ['桌面数字生命体', '唤醒词'],
          attribute: 'wakeWord',
          evidenceTerms: ['唤醒词', '小林', 'KWS'],
          needsRawEvidence: true,
          needsGlobalSearch: false,
          answerType: 'direct',
          confidence: 0.9,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )),
    );

    const result = await runStructuredQuery('桌面生命体和唤醒方案有什么关系', { planWithAgent: true });

    expect(result.answer).toContain('桌面数字生命体 和 唤醒词');
    expect(result.trace?.some((step) => step.layer === 'agent' && step.label === 'Query Agent')).toBe(true);
  });

  it('scans linked raw entries for attribute questions when the entity profile is incomplete', async () => {
    const entry = await createEntry({
      content:
        '项目定位：桌面数字生命体是运行在 Windows 桌面的 AI 生命体原型。语音输入部分持续优化，唤醒词目前走本地 PowerShell / Windows System.Speech 方案，主唤醒词是“小林”。',
      source: 'text',
    });
    await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '一个本地桌面智能体原型。',
      sourceEntries: [entry.id],
    });

    const result = await runStructuredQuery('桌面生命体的唤醒词是什么');

    expect(result.answer).toContain('唤醒词：小林');
    expect(result.answer).toContain('主唤醒词是“小林”');
    expect(result.answer).toContain('原始材料命中');
    expect(result.sources.some((source) => source.type === 'entry' && source.id === entry.id)).toBe(true);
    expect(result.trace?.some((step) => step.label === '原始材料兜底扫描')).toBe(true);
  });

  it('keeps structured property answers when LLM expression contradicts evidence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({
          answer: '桌面数字生命体的唤醒词在当前已召回材料中未被完整披露。',
          provider: 'minimax',
          model: 'MiniMax-M2.7',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )),
    );

    const entry = await createEntry({
      content: '语音输入部分持续优化，主唤醒词是“小林”，终止词使用 miki / mi ki。',
      source: 'text',
    });
    await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '一个本地桌面智能体原型。',
      sourceEntries: [entry.id],
    });

    const result = await runStructuredQuery('桌面生命体的唤醒词是什么', { composeWithLlm: true });

    expect(result.answer).toContain('唤醒词：小林');
    expect(result.answer).not.toContain('未被完整披露');
    expect(result.llm).toBeUndefined();
    expect(result.trace?.some((step) => step.detail.includes('结构化属性结论冲突'))).toBe(true);
  });

  it('keeps the fast answer when the LLM expression drifts from its factual skeleton', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({
          answer: '桌面数字生命体的唤醒词是“小李”，后续应该继续优化。',
          provider: 'minimax',
          model: 'MiniMax-M2.7',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )),
    );

    const entry = await createEntry({
      content: '语音输入部分持续优化，主唤醒词是“小林”，终止词使用 miki / mi ki。',
      source: 'text',
    });
    await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '一个本地桌面智能体原型。',
      sourceEntries: [entry.id],
    });

    const result = await runStructuredQuery('桌面生命体的唤醒词是什么', { composeWithLlm: true });

    expect(result.answer).toContain('唤醒词：小林');
    expect(result.answer).not.toContain('小李');
    expect(result.llm).toBeUndefined();
    expect(result.trace?.some((step) => step.detail.includes('偏离快速答案骨架'))).toBe(true);
  });

  it('extracts property values from the full source entry when the matched snippet is too narrow', async () => {
    const entry = await createEntry({
      content: [
        '唤醒词目前走本地 PowerShell / Windows System.Speech 方案。',
        '中间实现细节。'.repeat(80),
        '主唤醒词是“小林”，并围绕中文近音做了多轮优化。',
      ].join(''),
      source: 'text',
    });
    await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '一个本地桌面智能体原型。',
      sourceEntries: [entry.id],
    });

    const result = await runStructuredQuery('桌面生命体的唤醒词是什么');

    expect(result.answer).toContain('唤醒词：小林');
    expect(result.compileSuggestions?.[0]).toEqual(
      expect.objectContaining({
        propertyKey: 'wakeWord',
        propertyValue: '小林',
      }),
    );
    expect(result.compileSuggestions?.[0]?.evidenceSnippet).toContain('小林');
  });

  it('falls back to global raw entries when linked entries miss the requested attribute', async () => {
    const linkedEntry = await createEntry({
      content: '桌面数字生命体是运行在 Windows 桌面的 AI 生命体原型。',
      source: 'text',
    });
    const globalEntry = await createEntry({
      content: '语音链路补充：桌面生命体主唤醒词是“小林”，终止词使用 miki / mi ki / 米基 / 米奇 近音组。',
      source: 'text',
    });
    await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '一个本地桌面智能体原型。',
      sourceEntries: [linkedEntry.id],
    });

    const result = await runStructuredQuery('桌面生命体的终止词是什么');

    expect(result.answer).toContain('miki / mi ki / 米基 / 米奇');
    expect(result.answer).toContain('全库原始材料兜底');
    expect(result.sources.some((source) => source.type === 'entry' && source.id === globalEntry.id)).toBe(true);
  });

  it('reads source entries from graph-expanded candidate pages', async () => {
    const projectEntry = await createEntry({
      content: '桌面数字生命体需要稳定语音交互主链。',
      source: 'text',
    });
    const voiceEntry = await createEntry({
      content: '语音链路补充：桌面生命体终止词使用 miki / mi ki / 米基 / 米奇 近音组。',
      source: 'text',
    });
    const project = await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '桌面智能体原型。',
      sourceEntries: [projectEntry.id],
    });
    const voice = await createEntity({
      type: 'topic',
      title: '语音链路',
      summary: '语音交互主链。',
      sourceEntries: [voiceEntry.id],
    });
    await createRelationship({ from: project.id, to: voice.id, type: 'relevant-to', evidence: [projectEntry.id] });

    const result = await runStructuredQuery('桌面生命体的终止词是什么');

    expect(result.answer).toContain('miki / mi ki / 米基 / 米奇');
    expect(result.sources.some((source) => source.id === voiceEntry.id)).toBe(true);
    expect(result.trace?.some((step) => step.label === '多种子图谱扩展')).toBe(true);
  });

  it('limits LLM compose entries by context budget', async () => {
    let composePayload: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        composePayload = JSON.parse(String((init as RequestInit).body));
        return new Response(
          JSON.stringify({
            answer: '预算内回答',
            provider: 'deepseek',
            model: 'deepseek-v4-pro',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    const entry = await createEntry({
      content: `项目定位：桌面数字生命体是一个运行在 Windows 桌面的 AI 生命体原型。${'长材料。'.repeat(2000)}`,
      source: 'text',
    });
    await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '桌面智能体原型。',
      sourceEntries: [entry.id],
    });

    await runStructuredQuery('桌面生命体是什么', { composeWithLlm: true, maxContextChars: 4000 });

    const entries = (composePayload as { entries: Array<{ content: string }> }).entries;
    const totalChars = entries.reduce((sum, item) => sum + item.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(2000);
  });

  it('uses Query Agent planning to match natural questions to wiki pages and evidence terms', async () => {
    const entry = await createEntry({
      content: '项目定位：“桌面数字生命体”是一个运行在 Windows 桌面的 AI 生命体原型。',
      source: 'text',
    });
    const project = await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '桌面智能体原型。',
      sourceEntries: [entry.id],
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({
          intent: 'attribute_lookup',
          selectedEntityIds: [project.id],
          entityCandidates: ['数字生命体', '桌面数字生命体', '桌面生命体'],
          attribute: 'runtimeEnvironment',
          evidenceTerms: ['Windows', 'Windows 桌面', '运行在 Windows', '运行环境'],
          needsRawEvidence: true,
          needsGlobalSearch: false,
          answerType: 'yes_no_with_evidence',
          confidence: 0.9,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )),
    );

    const result = await runStructuredQuery('数字生命体能否在windows环境运行？', { planWithAgent: true });

    expect(result.answer).toContain('Windows');
    expect(result.sources.some((source) => source.id === entry.id)).toBe(true);
    expect(result.trace?.some((step) => step.layer === 'agent')).toBe(true);
    expect(result.compileSuggestions?.[0]).toEqual(
      expect.objectContaining({
        entityId: project.id,
        propertyKey: 'runtimeEnvironment',
        propertyValue: 'Windows',
      }),
    );
  });

  it('reads extra evidence pages selected by Query Agent', async () => {
    const projectEntry = await createEntry({
      content: '桌面数字生命体是一个运行在 Windows 桌面的 AI 生命体原型。',
      source: 'text',
    });
    const voiceEntry = await createEntry({
      content: '语音链路补充：桌面生命体终止词使用 miki / mi ki / 米基 / 米奇 近音组。',
      source: 'text',
    });
    const project = await createEntity({
      type: 'project',
      title: '桌面数字生命体',
      summary: '桌面智能体原型。',
      sourceEntries: [projectEntry.id],
    });
    const voice = await createEntity({
      type: 'topic',
      title: '语音链路',
      summary: '唤醒、聆听、终止词和播报组成的语音交互主链。',
      sourceEntries: [voiceEntry.id],
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({
          intent: 'attribute_lookup',
          selectedEntityIds: [project.id, voice.id],
          entityCandidates: ['桌面数字生命体', '语音链路'],
          attribute: 'stopWord',
          evidenceTerms: ['终止词', 'miki', 'mi ki', '米基', '米奇'],
          needsRawEvidence: true,
          needsGlobalSearch: false,
          answerType: 'direct',
          confidence: 0.9,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )),
    );

    const result = await runStructuredQuery('桌面生命体的终止词是什么', { planWithAgent: true });

    expect(result.answer).toContain('miki / mi ki / 米基 / 米奇');
    expect(result.sources.some((source) => source.id === voiceEntry.id)).toBe(true);
    expect(result.trace?.some((step) => step.label === 'Agent 证据范围')).toBe(true);
  });

  it('builds readable compile suggestions with precise derivedFrom values', async () => {
    const entry = await createEntry({
      content:
        '项目定位：企业 AI 培训课程市集是基于 OpenMaic 开源项目二次开发的企业内部培训平台。',
      source: 'text',
    });
    const duplicateEntry = await createEntry({
      content: '补充记录：企业 AI 培训课程市集来源于 OpenMaic 开源项目。',
      source: 'text',
    });
    const project = await createEntity({
      type: 'project',
      title: '企业 AI 培训课程市集',
      summary: '企业内部培训平台。',
      sourceEntries: [entry.id, duplicateEntry.id],
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({
          intent: 'attribute_lookup',
          selectedEntityIds: [project.id],
          entityCandidates: ['企业 AI 培训课程市集'],
          attribute: 'derivedFrom',
          evidenceTerms: ['基于', 'OpenMaic', '开源项目', '二次开发'],
          needsRawEvidence: true,
          needsGlobalSearch: false,
          answerType: 'direct',
          confidence: 0.9,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )),
    );

    const result = await runStructuredQuery('企业 AI 培训课程市集基于什么开源项目？', { planWithAgent: true });

    expect(result.compileSuggestions).toHaveLength(1);
    expect(result.compileSuggestions?.[0]).toEqual(
      expect.objectContaining({
        entityId: project.id,
        propertyKey: 'derivedFrom',
        propertyLabel: '来源/基于项目',
        propertyValue: 'OpenMaic 开源项目',
      }),
    );
    expect(result.compileSuggestions?.[0]?.propertyValue).not.toBe('开源');
  });

  it('filters compile suggestions when derivedFrom evidence belongs to another entity', async () => {
    const entry = await createEntry({
      content: '桌面数字生命体是基于 OpenMaic 开源项目二次开发的桌面智能体原型。',
      source: 'text',
    });
    const project = await createEntity({
      type: 'project',
      title: '企业 AI 培训课程市集',
      summary: '企业内部培训平台。',
      sourceEntries: [entry.id],
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({
          intent: 'attribute_lookup',
          selectedEntityIds: [project.id],
          entityCandidates: ['企业 AI 培训课程市集'],
          attribute: 'derivedFrom',
          evidenceTerms: ['基于', 'OpenMaic', '开源项目', '二次开发'],
          needsRawEvidence: true,
          needsGlobalSearch: false,
          answerType: 'direct',
          confidence: 0.9,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )),
    );

    const result = await runStructuredQuery('企业 AI 培训课程市集基于什么开源项目？', { planWithAgent: true });

    expect(result.compileSuggestions ?? []).toEqual([]);
  });

  it('classifies open source questions as openSourceStatus and does not repeat after apply', async () => {
    const entry = await createEntry({
      content: 'OpenMaic 是开源项目，企业 AI 培训课程市集基于 OpenMaic 开源项目二次开发。',
      source: 'text',
    });
    const openMaic = await createEntity({
      type: 'topic',
      title: 'OpenMaic',
      summary: '企业 AI 培训课程市集的上游项目。',
      sourceEntries: [entry.id],
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({
          intent: 'attribute_lookup',
          selectedEntityIds: [openMaic.id],
          entityCandidates: ['OpenMaic'],
          attribute: 'derivedFrom',
          evidenceTerms: ['开源', '开源项目'],
          needsRawEvidence: true,
          needsGlobalSearch: false,
          answerType: 'yes_no_with_evidence',
          confidence: 0.8,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )),
    );

    const firstResult = await runStructuredQuery('OpenMaic是开源的吗？', { planWithAgent: true });

    expect(firstResult.compileSuggestions).toHaveLength(1);
    expect(firstResult.compileSuggestions?.[0]).toEqual(
      expect.objectContaining({
        entityId: openMaic.id,
        propertyKey: 'openSourceStatus',
        propertyLabel: '开源状态',
        propertyValue: '开源项目',
        status: 'pending',
      }),
    );

    await applyCompileSuggestion(firstResult.compileSuggestions![0]!.id);

    const updatedEntity = await getEntity(openMaic.id);
    expect((updatedEntity?.properties as Record<string, unknown>).openSourceStatus).toBe('开源项目');

    const secondResult = await runStructuredQuery('OpenMaic是开源的吗？', { planWithAgent: true });

    expect(secondResult.answer).toContain('开源状态：开源项目');
    expect(secondResult.compileSuggestions ?? []).toEqual([]);
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

  it('caches repeated composed query answers while knowledge is unchanged', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        answer: '桌面数字生命体是运行在 Windows 桌面的 AI 生命体原型，这是缓存后的优化回答。',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

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

    const first = await runStructuredQuery('桌面生命体是什么', { composeWithLlm: true });
    const second = await runStructuredQuery('桌面生命体是什么', { composeWithLlm: true });

    expect(first.answer).toBe('桌面数字生命体是运行在 Windows 桌面的 AI 生命体原型，这是缓存后的优化回答。');
    expect(second.answer).toBe('桌面数字生命体是运行在 Windows 桌面的 AI 生命体原型，这是缓存后的优化回答。');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.trace?.some((step) => step.layer === 'cache')).toBe(true);
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
