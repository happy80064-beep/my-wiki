import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryInput } from '../QueryInput';

describe('QueryInput', () => {
  it('submits a question and does not render manual query mode switches', async () => {
    const onSend = vi.fn();

    render(<QueryInput onSend={onSend} />);

    expect(screen.queryByRole('switch', { name: /简单查询/ })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText(/输入你的问题/), {
      target: { value: '福瑞科技园三期什么时候完工？' },
    });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('福瑞科技园三期什么时候完工？');
    });
  });
});
