export type TriPaneLayout = {
  left: number;
  center: number;
  right: number;
};

const MIN_PANEL_PERCENT = 18;

export function normalizeTriPaneLayout(layout: TriPaneLayout): TriPaneLayout {
  const total = layout.left + layout.center + layout.right;
  if (total <= 0) {
    return { left: 26, center: 30, right: 44 };
  }

  let next = {
    left: (layout.left / total) * 100,
    center: (layout.center / total) * 100,
    right: (layout.right / total) * 100,
  };

  next = clampPanel(next, 'left');
  next = clampPanel(next, 'center');
  next = clampPanel(next, 'right');

  const normalizedTotal = next.left + next.center + next.right;
  return {
    left: roundPercent((next.left / normalizedTotal) * 100),
    center: roundPercent((next.center / normalizedTotal) * 100),
    right: roundPercent((next.right / normalizedTotal) * 100),
  };
}

export function resizeTriPaneLayout(
  layout: TriPaneLayout,
  handle: 'left-center' | 'center-right',
  deltaPercent: number,
): TriPaneLayout {
  if (handle === 'left-center') {
    return normalizeTriPaneLayout({
      left: layout.left + deltaPercent,
      center: layout.center - deltaPercent,
      right: layout.right,
    });
  }

  return normalizeTriPaneLayout({
    left: layout.left,
    center: layout.center + deltaPercent,
    right: layout.right - deltaPercent,
  });
}

function clampPanel(layout: TriPaneLayout, key: keyof TriPaneLayout): TriPaneLayout {
  const value = layout[key];
  if (value >= MIN_PANEL_PERCENT) return layout;

  const deficit = MIN_PANEL_PERCENT - value;
  const others = (['left', 'center', 'right'] as Array<keyof TriPaneLayout>).filter((item) => item !== key);
  let next = { ...layout, [key]: MIN_PANEL_PERCENT } as TriPaneLayout;

  for (const other of others) {
    const available = Math.max(0, next[other] - MIN_PANEL_PERCENT);
    const reduction = Math.min(available, deficit / others.length);
    next[other] -= reduction;
  }

  let remaining = next.left + next.center + next.right - 100;
  if (remaining > 0) {
    for (const other of others) {
      const available = Math.max(0, next[other] - MIN_PANEL_PERCENT);
      const reduction = Math.min(available, remaining);
      next[other] -= reduction;
      remaining -= reduction;
      if (remaining <= 0) break;
    }
  } else if (remaining < 0) {
    next[others[0]] += Math.abs(remaining);
  }

  return next;
}

function roundPercent(value: number) {
  return Math.round(value * 100) / 100;
}
