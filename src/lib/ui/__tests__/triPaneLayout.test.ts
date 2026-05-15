import { describe, expect, it } from 'vitest';
import { normalizeTriPaneLayout, resizeTriPaneLayout } from '../triPaneLayout';

describe('tri pane layout helpers', () => {
  it('normalizes pane widths to 100 percent', () => {
    expect(normalizeTriPaneLayout({ left: 260, center: 420, right: 760 })).toEqual({
      left: 18.06,
      center: 29.17,
      right: 52.78,
    });
  });

  it('keeps each pane above the minimum width while resizing left-center handle', () => {
    expect(resizeTriPaneLayout({ left: 26, center: 30, right: 44 }, 'left-center', -20)).toEqual({
      left: 18,
      center: 44,
      right: 38,
    });
  });

  it('keeps each pane above the minimum width while resizing center-right handle', () => {
    expect(resizeTriPaneLayout({ left: 26, center: 30, right: 44 }, 'center-right', 30)).toEqual({
      left: 24,
      center: 58,
      right: 18,
    });
  });
});
