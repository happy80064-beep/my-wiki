import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEntity, createEntry, db, resetDatabase } from '@/lib/db';
import { publishWikiBatchCompileStatus } from '@/lib/wiki/batchCompileStatus';
import { getBrowserWikiBatchRecompilePromise } from '@/lib/wiki/batchRecompileQueue';
import { BrowserIndexedDbWikiPage } from '../WikiPage';

describe('BrowserIndexedDbWikiPage', () => {
  beforeEach(async () => {
    await getBrowserWikiBatchRecompilePromise()?.catch(() => undefined);
    window.localStorage.clear();
    vi.restoreAllMocks();
    Object.defineProperty(window, 'confirm', {
      value: vi.fn(() => true),
      configurable: true,
    });
    await resetDatabase();
  });

  it('edits full wiki markdown instead of only title/summary/tags when a page already has wikiMarkdown', async () => {
    const entity = await createEntity({
      type: 'topic',
      title: '旧标题',
      summary: '旧摘要',
      tags: ['旧标签'],
    });

    await db.entities.update(entity.id, {
      wikiMarkdown: [
        '---',
        'type: topic',
        'title: "新标题"',
        'tags: [AI技巧, 工作流]',
        '---',
        '',
        '# 新标题',
        '',
        '## 摘要',
        '这是新的摘要内容。',
      ].join('\n'),
      wikiCompiledAt: Date.now(),
      wikiCompileModel: 'minimax-cn:MiniMax-M2.7',
    });

    render(<BrowserIndexedDbWikiPage />);

    await waitFor(() => {
      expect(screen.getAllByText('旧标题').length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByText('旧标题')[0]);
    fireEvent.click(screen.getByLabelText('编辑页面'));

    const textarea = await screen.findByLabelText('Markdown 全文');
    expect(textarea).toBeTruthy();
    expect(screen.queryByLabelText('标题')).toBeNull();
    expect(screen.queryByLabelText('摘要 / 正文')).toBeNull();
    expect(screen.queryByLabelText('标签')).toBeNull();

    fireEvent.change(textarea, {
      target: {
        value: [
          '---',
          'type: topic',
          'title: "Prompt技巧"',
          'tags: [AI技巧, 提示词]',
          '---',
          '',
          '# Prompt技巧',
          '',
          '## 摘要',
          '这是重写后的 Wiki 页面摘要。',
        ].join('\n'),
      },
    });

    fireEvent.click(screen.getByLabelText('保存页面'));

    await waitFor(async () => {
      const updated = await db.entities.get(entity.id);
      expect(updated?.title).toBe('Prompt技巧');
      expect(updated?.summary).toContain('这是重写后的 Wiki 页面摘要');
      expect(updated?.tags).toEqual(['AI技巧', '提示词']);
      expect(updated?.wikiMarkdown).toContain('# Prompt技巧');
    });
  });

  it('also opens a full markdown editor for entities that have not been recompiled yet', async () => {
    await createEntity({
      type: 'project',
      title: '未编译项目页',
      summary: '这是旧版实体摘要。',
      tags: ['项目', '待编译'],
    });

    render(<BrowserIndexedDbWikiPage />);

    await waitFor(() => {
      expect(screen.getAllByText('未编译项目页').length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByText('未编译项目页')[0]);
    fireEvent.click(screen.getByLabelText('编辑页面'));

    const textarea = await screen.findByLabelText('Markdown 全文');
    expect(textarea).toBeTruthy();
    expect((textarea as HTMLTextAreaElement).value).toContain('# 未编译项目页');
    expect((textarea as HTMLTextAreaElement).value).toContain('## 摘要');
    expect((textarea as HTMLTextAreaElement).value).not.toContain('<think>');
  });

  it('hides polluted wiki descriptions and repairs them in the background', async () => {
    const entity = await createEntity({
      type: 'topic',
      title: '查询洞察：卡兹克是谁？',
      summary: '旧摘要',
      tags: ['query-insight'],
    });

    await db.entities.update(entity.id, {
      wikiMarkdown: [
        '---',
        'type: topic',
        'title: "查询洞察：卡兹克是谁？"',
        'description: "MiniMax failed: fetch failed ??? ??? Wiki ?? ###### 3279 / OpenAI / ???? / ????"',
        'tags: [query-insight]',
        'sources: []',
        'related: []',
        '---',
        '',
        '# 查询洞察：卡兹克是谁？',
        '',
        '## 摘要',
        '卡兹克是一个公众号内容数据分析运营 AI 热点写作方法。',
      ].join('\n'),
    });

    render(<BrowserIndexedDbWikiPage />);

    await waitFor(() => {
      expect(screen.getAllByText('查询洞察：卡兹克是谁？').length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByText('查询洞察：卡兹克是谁？')[0]);

    await waitFor(() => {
      expect(screen.getAllByText('卡兹克是一个公众号内容数据分析运营 AI 热点写作方法。').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/MiniMax failed/i)).toBeNull();

    await waitFor(async () => {
      const updated = await db.entities.get(entity.id);
      expect(updated?.wikiMarkdown).not.toContain('MiniMax failed');
    });
  });

  it('keeps the left wiki tree in a stable title order while repairing polluted topic pages', async () => {
    const later = await createEntity({
      type: 'topic',
      title: '查询洞察：后面的问题',
      summary: '后面的问题摘要',
      tags: ['query-insight'],
    });
    const earlier = await createEntity({
      type: 'topic',
      title: '查询洞察：前面的问题',
      summary: '前面的问题摘要',
      tags: ['query-insight'],
    });

    await db.entities.update(later.id, {
      wikiMarkdown: [
        '---',
        'type: topic',
        'title: "查询洞察：后面的问题"',
        'description: "MiniMax failed: fetch failed ??? ??? Wiki ?? ###### 3279 / OpenAI / ???? / ????"',
        'tags: [query-insight]',
        '---',
        '',
        '# 查询洞察：后面的问题',
        '',
        '## 摘要',
        '这是后面的问题摘要。',
      ].join('\n'),
    });

    await db.entities.update(earlier.id, {
      wikiMarkdown: [
        '---',
        'type: topic',
        'title: "查询洞察：前面的问题"',
        'description: "MiniMax failed: fetch failed ??? ??? Wiki ?? ###### 3279 / OpenAI / ???? / ????"',
        'tags: [query-insight]',
        '---',
        '',
        '# 查询洞察：前面的问题',
        '',
        '## 摘要',
        '这是前面的问题摘要。',
      ].join('\n'),
    });

    render(<BrowserIndexedDbWikiPage />);

    await waitFor(() => {
      expect(screen.getAllByText('查询洞察：前面的问题').length).toBeGreaterThan(0);
      expect(screen.getAllByText('查询洞察：后面的问题').length).toBeGreaterThan(0);
    });

    const topicButtons = screen
      .getAllByRole('button')
      .filter((button) => button.textContent?.includes('查询洞察：前面的问题') || button.textContent?.includes('查询洞察：后面的问题'));

    const initialOrder = topicButtons.map((button) =>
      button.textContent?.includes('查询洞察：前面的问题') ? '查询洞察：前面的问题' : '查询洞察：后面的问题',
    );
    expect(initialOrder).toHaveLength(2);

    await waitFor(async () => {
      const updatedLater = await db.entities.get(later.id);
      const updatedEarlier = await db.entities.get(earlier.id);
      expect(updatedLater?.wikiMarkdown).not.toContain('MiniMax failed');
      expect(updatedEarlier?.wikiMarkdown).not.toContain('MiniMax failed');
    });

    const topicButtonsAfterRepair = screen
      .getAllByRole('button')
      .filter((button) => button.textContent?.includes('查询洞察：前面的问题') || button.textContent?.includes('查询洞察：后面的问题'));

    const orderAfterRepair = topicButtonsAfterRepair.map((button) =>
      button.textContent?.includes('查询洞察：前面的问题') ? '查询洞察：前面的问题' : '查询洞察：后面的问题',
    );
    expect(orderAfterRepair).toEqual(initialOrder);
  });
  it('collapses an entity group from the left tree', async () => {
    await createEntity({
      type: 'topic',
      title: 'Alpha Topic',
      summary: 'Alpha summary',
      tags: ['alpha'],
    });

    render(<BrowserIndexedDbWikiPage />);

    await screen.findAllByText('Alpha Topic');
    const entityButton = screen.getAllByRole('button').find((button) => button.textContent?.includes('Alpha Topic'));
    const section = entityButton?.closest('section');
    expect(section).toBeTruthy();

    const headerButton = section?.querySelector('button');
    expect(headerButton).toBeTruthy();
    fireEvent.click(headerButton!);

    await waitFor(() => {
      expect(screen.queryAllByRole('button').some((button) => button.textContent?.includes('Alpha Topic'))).toBe(false);
    });
  });

  it('renders the browser knowledge tree as compact title-only page groups', async () => {
    await createEntity({
      type: 'topic',
      title: '本地优先存储',
      summary: '这是一段很长的摘要，过去会撑开左侧知识树，现在不应该在左侧列表里直接展示。',
      tags: ['concept'],
    });

    render(<BrowserIndexedDbWikiPage />);

    await screen.findAllByText('本地优先存储');
    const leftTree = screen.getByText('知识树').closest('main');
    expect(leftTree).toBeTruthy();

    expect(within(leftTree as HTMLElement).getByText('概念')).toBeTruthy();
    expect(within(leftTree as HTMLElement).getByText('本地优先存储')).toBeTruthy();
    expect(within(leftTree as HTMLElement).queryByText(/这是一段很长的摘要/)).toBeNull();
  });

  it('groups edited wiki pages by frontmatter type instead of stale type tags', async () => {
    const entity = await createEntity({
      type: 'project',
      title: '出版业',
      summary: '旧摘要。',
      tags: ['项目', '产业链', '出版'],
    });
    await db.entities.update(entity.id, {
      wikiMarkdown: [
        '---',
        'type: concept',
        'title: "出版业"',
        'tags: ["项目","产业链","出版"]',
        '---',
        '',
        '# 出版业',
        '',
        '## 摘要',
        '出版业应归为概念页。',
      ].join('\n'),
    });

    render(<BrowserIndexedDbWikiPage />);

    await screen.findAllByText('出版业');
    const leftTree = screen.getByText('知识树').closest('main');
    expect(leftTree).toBeTruthy();

    expect(within(leftTree as HTMLElement).getByText('概念')).toBeTruthy();
    expect(within(leftTree as HTMLElement).getByText('出版业')).toBeTruthy();
    expect(within(leftTree as HTMLElement).queryByText('项目')).toBeNull();
  });

  it('prioritizes source-backed pages whose wiki is still ungenerated during batch generation', async () => {
    const confirmSpy = vi.fn(() => false);
    Object.defineProperty(window, 'confirm', {
      value: confirmSpy,
      configurable: true,
    });
    await createEntity({
      type: 'project',
      title: '未生成项目',
      summary: '已有结构化来源，尚未生成 Wiki。',
      sourceEntries: ['entry_missing'],
    });
    const complete = await createEntity({
      type: 'project',
      title: '已生成项目',
      summary: '已有完整 Wiki。',
      sourceEntries: ['entry_complete'],
    });
    await db.entities.update(complete.id, {
      wikiMarkdown: ['# 已生成项目', '', '## 摘要', '这是一份已经生成过的 Wiki 页面。'].join('\n'),
      wikiCompiledAt: Date.now(),
      wikiCompileModel: 'test/mock',
    });
    await createEntity({
      type: 'project',
      title: '无来源项目',
      summary: '没有来源，不应参与批量生成。',
    });

    render(<BrowserIndexedDbWikiPage />);

    fireEvent.click(await screen.findByRole('button', { name: '批量生成/更新wiki页' }));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('1 个未生成词条'));
    });
  });

  it('runs a full batch update only when every source-backed page already has wiki content', async () => {
    const confirmSpy = vi.fn(() => false);
    Object.defineProperty(window, 'confirm', {
      value: confirmSpy,
      configurable: true,
    });
    const first = await createEntity({
      type: 'project',
      title: '已生成项目 A',
      summary: '已有完整 Wiki。',
      sourceEntries: ['entry_a'],
    });
    const second = await createEntity({
      type: 'topic',
      title: '已生成概念 B',
      summary: '已有完整 Wiki。',
      sourceEntries: ['entry_b'],
    });
    const compiledPatch = {
      wikiMarkdown: ['# 已生成', '', '## 摘要', '这是一份已经生成过的 Wiki 页面。'].join('\n'),
      wikiCompiledAt: Date.now(),
      wikiCompileModel: 'test/mock',
    };
    await db.entities.update(first.id, compiledPatch);
    await db.entities.update(second.id, compiledPatch);

    render(<BrowserIndexedDbWikiPage />);

    fireEvent.click(await screen.findByRole('button', { name: '批量生成/更新wiki页' }));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('2 个 Wiki 页面'));
      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('全量更新'));
    });
  });

  it('deletes a wiki page from the left knowledge tree', async () => {
    const entity = await createEntity({
      type: 'topic',
      title: '可删除知识页',
      summary: '这页用于测试删除。',
      tags: ['concept'],
    });

    render(<BrowserIndexedDbWikiPage />);

    await screen.findAllByText('可删除知识页');
    fireEvent.click(screen.getByLabelText('删除知识页 可删除知识页'));

    await waitFor(async () => {
      expect(await db.entities.get(entity.id)).toBeUndefined();
    });
  });

  it('deletes a page type group from the left knowledge tree', async () => {
    const first = await createEntity({
      type: 'topic',
      title: '概念页 A',
      summary: '这页属于概念分组。',
      tags: ['concept'],
    });
    const second = await createEntity({
      type: 'topic',
      title: '概念页 B',
      summary: '这页也属于概念分组。',
      tags: ['concept'],
    });

    render(<BrowserIndexedDbWikiPage />);

    await screen.findByText('概念页 A');
    fireEvent.click(screen.getByLabelText('删除 概念 分组知识页'));

    await waitFor(async () => {
      expect(await db.entities.get(first.id)).toBeUndefined();
      expect(await db.entities.get(second.id)).toBeUndefined();
    });
  });

  it('deletes a source item from the middle source list without deleting generated wiki pages', async () => {
    const entry = await createEntry({
      content: 'Source entry body',
      source: 'file',
      fileMetadata: {
        filename: 'source-note.md',
        mimeType: 'text/markdown',
        url: 'file:///source-note.md',
      },
    });
    const entity = await createEntity({
      type: 'topic',
      title: '来源关联主题',
      summary: '由 source-note 生成。',
      tags: ['concept'],
      sourceEntries: [entry.id],
    });

    render(<BrowserIndexedDbWikiPage />);

    await screen.findByText('source-note.md');
    fireEvent.click(screen.getByLabelText('删除原始材料 source-note.md'));

    await waitFor(async () => {
      expect(await db.entries.get(entry.id)).toBeUndefined();
      expect(await db.entities.get(entity.id)).toBeTruthy();
      expect((await db.entities.get(entity.id))?.sourceEntries).not.toContain(entry.id);
    });
  });

  it('imports a single raw file from the wiki source column without using backup restore', async () => {
    render(<BrowserIndexedDbWikiPage />);

    const file = new File(['# 单文件导入\n\n这是一份原始材料。'], 'single-import.md', { type: 'text/markdown' });
    fireEvent.change(screen.getByTestId('raw-file-import-input'), { target: { files: [file] } });

    await waitFor(async () => {
      expect(await db.rawAssets.count()).toBe(1);
      expect(await db.entries.count()).toBe(1);
    });
    expect((await screen.findAllByText('single-import.md')).length).toBeGreaterThan(0);
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('opens related entities and source entries from metadata chips', async () => {
    const sourceEntry = await createEntry({
      content: 'Source entry body',
      source: 'text',
      fileMetadata: {
        filename: 'source-note.md',
        mimeType: 'text/markdown',
        url: 'file:///source-note.md',
      },
    });

    await createEntity({
      type: 'topic',
      title: 'Related Topic',
      summary: 'Related summary',
      tags: ['linked'],
    });

    const primaryEntity = await createEntity({
      type: 'topic',
      title: 'Primary Topic',
      summary: 'Primary summary',
      tags: ['main'],
      sourceEntries: [sourceEntry.id],
    });

    await db.entities.update(primaryEntity.id, {
      wikiMarkdown: [
        '---',
        'type: topic',
        'title: "Primary Topic"',
        'tags: [main]',
        'sources: ["source-note.md"]',
        'related: ["Related Topic"]',
        '---',
        '',
        '# Primary Topic',
        '',
        'Primary body',
      ].join('\n'),
    });

    render(<BrowserIndexedDbWikiPage />);

    fireEvent.click(await screen.findByText('Primary Topic'));

    const rightPanel = document.querySelectorAll('aside')[1];
    expect(rightPanel).toBeTruthy();
    fireEvent.click(within(rightPanel as HTMLElement).getAllByRole('button', { name: /Related Topic/i })[0]);
    await waitFor(() => {
      expect(screen.getAllByText('Related Topic').length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByText('Primary Topic')[0]);
    fireEvent.click(within(rightPanel as HTMLElement).getByRole('button', { name: /source-note\.md/i }));

    await waitFor(() => {
      expect(within(rightPanel as HTMLElement).getAllByText(/Source entry body/i).length).toBeGreaterThan(0);
    });
  });

  it('opens related pages when frontmatter related values are wikilink paths', async () => {
    await createEntity({
      type: 'topic',
      title: '运营经理',
      summary: '岗位页面',
      tags: ['concept'],
    });

    const primary = await createEntity({
      type: 'person',
      title: '李俊杰',
      summary: '人物页面',
      tags: ['人物'],
    });

    await db.entities.update(primary.id, {
      wikiMarkdown: [
        '---',
        'type: entity',
        'title: "李俊杰"',
        'tags: [人物]',
        'sources: []',
        'related: ["[[concepts/运营经理]]"]',
        '---',
        '',
        '# 李俊杰',
        '',
        '## 摘要',
        '李俊杰曾任 [[concepts/运营经理]]。',
      ].join('\n'),
    });

    render(<BrowserIndexedDbWikiPage />);

    fireEvent.click(await screen.findByText('李俊杰'));
    const rightPanel = document.querySelectorAll('aside')[1];
    expect(rightPanel).toBeTruthy();
    fireEvent.click(within(rightPanel as HTMLElement).getByRole('button', { name: /concepts\/运营经理/i }));

    await waitFor(() => {
      expect(screen.getAllByText('运营经理').length).toBeGreaterThan(0);
    });
  });

  it('searches wiki pages by full text content from the knowledge column', async () => {
    await createEntity({
      type: 'topic',
      title: 'A 页面',
      summary: '默认选中的页面。',
      tags: ['overview'],
    });

    await createEntity({
      type: 'topic',
      title: '办公楼调研页',
      summary: '一篇关于办公楼的调研。',
      tags: ['query-insight'],
      sourceEntries: [],
    }).then(async (entity) => {
      await db.entities.update(entity.id, {
        wikiMarkdown: [
          '---',
          'type: query',
          'title: "办公楼调研页"',
          'tags: [query-insight]',
          'sources: []',
          'related: []',
          '---',
          '',
          '# 办公楼调研页',
          '',
          '## 摘要',
          '中海广场是一座甲级写字楼，楼下有商业配套。',
        ].join('\n'),
      });
    });

    render(<BrowserIndexedDbWikiPage />);

    const knowledgePanel = (await screen.findByText('知识树')).closest('main');
    expect(knowledgePanel).toBeTruthy();

    const searchInput = within(knowledgePanel as HTMLElement).getByLabelText('搜索 Wiki 页面');
    fireEvent.change(searchInput, { target: { value: '中海广场' } });

    await waitFor(() => {
      expect(within(knowledgePanel as HTMLElement).getByText('1 pages')).toBeTruthy();
      expect(within(knowledgePanel as HTMLElement).getByText('办公楼调研页')).toBeTruthy();
      expect(within(knowledgePanel as HTMLElement).getByText(/wiki\/queries\//i)).toBeTruthy();
    });

    fireEvent.click(within(knowledgePanel as HTMLElement).getByText('办公楼调研页'));

    await waitFor(() => {
      expect(screen.getAllByText('办公楼调研页').length).toBeGreaterThan(1);
      expect(screen.getAllByText(/中海广场是一座甲级写字楼/).length).toBeGreaterThan(0);
    });
  });

  it('restores a running batch wiki generation state after the page is opened again', async () => {
    const now = Date.now();
    publishWikiBatchCompileStatus({
      id: 'wiki-run-test',
      owner: 'wiki',
      stage: 'running',
      percent: 41,
      label: '正在生成/更新 Wiki 页面 2/5',
      detail: '福瑞健康科技园三期项目',
      total: 5,
      processed: 1,
      succeeded: 1,
      failed: 0,
      currentEntityId: 'entity-test',
      currentTitle: '福瑞健康科技园三期项目',
      startedAt: now,
      updatedAt: now,
    });

    render(<BrowserIndexedDbWikiPage />);

    const batchButton = await screen.findByRole('button', { name: /批量生成\/更新中 41%|批量生成\/更新wiki页/ });
    await waitFor(() => {
      expect((batchButton as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.getByText(/旧版批量生成任务已暂停|正在生成\/更新 Wiki 页面/)).toBeTruthy();
  });
});
