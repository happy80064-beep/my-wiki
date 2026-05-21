import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEntity, resetDatabase } from '@/lib/db';
import { GraphPage } from '../GraphPage';

describe('GraphPage', () => {
  beforeEach(async () => {
    await resetDatabase();
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
});
