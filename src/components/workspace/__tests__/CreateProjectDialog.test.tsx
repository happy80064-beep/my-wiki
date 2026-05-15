import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CreateProjectDialog } from '../CreateProjectDialog';

describe('CreateProjectDialog', () => {
  it('renders a Chinese-first project creation flow', () => {
    render(
      <CreateProjectDialog
        open
        defaultParentDirectory="D:/Knowledge"
        onClose={() => undefined}
        onCreate={() => undefined}
      />,
    );

    expect(screen.getByText('创建新的 Wiki 知识库')).toBeTruthy();
    expect(screen.getByText('项目名称')).toBeTruthy();
    expect(screen.getByText('模板')).toBeTruthy();
    expect(screen.getByDisplayValue('简体中文')).toBeTruthy();
    expect(screen.getByText('业务')).toBeTruthy();
    expect(screen.getByText('通用')).toBeTruthy();
  });

  it('submits project name, parent directory, template and output language', () => {
    const onCreate = vi.fn();
    render(
      <CreateProjectDialog
        open
        defaultParentDirectory="D:/Knowledge"
        onClose={() => undefined}
        onCreate={onCreate}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('例如：福瑞项目知识库'), {
      target: { value: '福瑞项目知识库' },
    });
    fireEvent.click(screen.getByText('业务'));
    fireEvent.click(screen.getByText('创建'));

    expect(onCreate).toHaveBeenCalledWith({
      projectName: '福瑞项目知识库',
      parentDirectory: 'D:/Knowledge',
      templateId: 'business',
      outputLanguage: 'zh-CN',
    });
  });

  it('does not render when closed', () => {
    render(
      <CreateProjectDialog
        open={false}
        defaultParentDirectory="D:/Knowledge"
        onClose={() => undefined}
        onCreate={() => undefined}
      />,
    );

    expect(screen.queryByText('创建新的 Wiki 知识库')).toBeNull();
  });
});
