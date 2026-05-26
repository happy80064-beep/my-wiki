import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEntity, createRelationship, resetDatabase } from '@/lib/db';
import { useResearchStore } from '@/lib/research/store';
import { GraphPage } from '../GraphPage';

vi.mock('@/components/graph/SigmaKnowledgeGraph', () => ({
  SigmaKnowledgeGraph: () => <div data-testid="sigma-graph" />,
}));

describe('GraphPage', () => {
  beforeEach(async () => {
    await resetDatabase();
    useResearchStore.setState({ tasks: [], runTask: async () => undefined });
  });

  it('opens graph entities through the current wiki page instead of the legacy entity editor route', async () => {
    const entity = await createEntity({
      type: 'project',
      title: '福瑞健康科技园三期项目',
      summary: '用于图谱跳转测试。',
    });

    render(
      <MemoryRouter>
        <GraphPage />
      </MemoryRouter>,
    );

    await screen.findAllByText('福瑞健康科技园三期项目');

    await waitFor(() => {
      const links = Array.from(document.querySelectorAll('a[href]')).map((link) => link.getAttribute('href'));
      expect(links).toContain(`/wiki?ref=${encodeURIComponent(entity.title)}`);
      expect(links).not.toContain(`/wiki/${entity.type}/${entity.id}`);
    });
  });

  it('keeps deep research visible after starting from a graph insight', async () => {
    const project = await createEntity({ type: 'project', title: '桥接项目', sourceEntries: ['entry-a'] });
    const person = await createEntity({ type: 'person', title: '王冠一', sourceEntries: ['entry-a'] });
    const topic = await createEntity({ type: 'topic', title: '价值医疗', sourceEntries: ['entry-b'] });
    const event = await createEntity({ type: 'event', title: '调研会议', sourceEntries: ['entry-c'] });
    await createRelationship({ from: project.id, to: person.id, type: 'participant', evidence: ['entry-a'] });
    await createRelationship({ from: project.id, to: topic.id, type: 'about', evidence: ['entry-b'] });
    await createRelationship({ from: project.id, to: event.id, type: 'mentioned-in', evidence: ['entry-c'] });

    render(
      <MemoryRouter>
        <GraphPage />
      </MemoryRouter>,
    );

    await screen.findByText('类型：桥接节点');
    fireEvent.click(screen.getByRole('button', { name: /用这条洞察发起研究/ }));

    expect(screen.getByText('确认并开始研究')).toBeTruthy();
    expect(screen.getByText(/已根据当前洞察自动填好主题和搜索词/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /开始并打开研究面板/ }));

    await screen.findByText(/已开始研究：桥接节点：桥接项目/);
    expect(screen.getByText('网页搜索、总结并保存为可入库的研究条目。')).toBeTruthy();
    expect(screen.getByText('排队中')).toBeTruthy();
  });
});
