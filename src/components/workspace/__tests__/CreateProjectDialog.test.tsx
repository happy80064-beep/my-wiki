import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { CreateProjectDialog } from '../CreateProjectDialog';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

describe('CreateProjectDialog', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

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

  it('keeps the parent directory picker disabled outside the desktop shell', () => {
    render(
      <CreateProjectDialog
        open
        defaultParentDirectory="D:/Knowledge"
        onClose={() => undefined}
        onCreate={() => undefined}
      />,
    );

    expect((screen.getByRole('button', { name: '选择父目录' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('updates the parent directory from the desktop directory picker', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });
    vi.mocked(openDialog).mockResolvedValue('C:\\Knowledge\\Projects');

    render(
      <CreateProjectDialog
        open
        defaultParentDirectory="D:/Knowledge"
        onClose={() => undefined}
        onCreate={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '选择父目录' }));

    await waitFor(() => {
      expect(openDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          directory: true,
          multiple: false,
          title: '选择知识库父目录',
        }),
      );
      expect(screen.getByDisplayValue('C:/Knowledge/Projects')).toBeTruthy();
    });
  });
});
