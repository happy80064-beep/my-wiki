import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkspaceStatusCard } from '../WorkspaceStatusCard';

describe('WorkspaceStatusCard', () => {
  it('explains when the current browser cannot access a file workspace', async () => {
    render(<WorkspaceStatusCard />);

    await waitFor(() => {
      expect(screen.getByText('v2 文件工作区')).toBeTruthy();
      expect(screen.getByText(/当前浏览器环境不能直接读写本地文件夹/)).toBeTruthy();
    });

    expect(screen.queryByLabelText('项目模板')).toBeNull();
  });
});
