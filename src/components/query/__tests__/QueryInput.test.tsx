import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryInput } from '../QueryInput';

describe('QueryInput', () => {
  it('shows simple query switch and reports toggle changes', () => {
    const onSimpleQueryChange = vi.fn();

    render(<QueryInput simpleQuery={false} onSimpleQueryChange={onSimpleQueryChange} onSend={vi.fn()} />);

    const toggle = screen.getByRole('switch', { name: /简单查询/ });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);

    expect(onSimpleQueryChange).toHaveBeenCalledWith(true);
  });
});
