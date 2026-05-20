import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rawAssetMocks = vi.hoisted(() => ({
  createRawAssetFromFile: vi.fn(),
  createRawAssetFromUrl: vi.fn(),
  processRawAssetQueue: vi.fn(async (_input: unknown) => ({ total: 1, processed: 1, failed: 0 })),
  resetStaleRawAssets: vi.fn(async () => 0),
  subscribeRawAssetQueueStatus: vi.fn(() => () => undefined),
}));

vi.mock('@/lib/rawAssets', () => rawAssetMocks);

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_query: unknown, _deps: unknown, defaultResult: unknown) => defaultResult,
}));

vi.mock('@/lib/runtime/tauri', () => ({
  isTauriRuntime: () => false,
}));

vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalSize: class LogicalSize {
    width: number;
    height: number;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
  },
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setSize: vi.fn(async () => undefined),
    startDragging: vi.fn(async () => undefined),
    minimize: vi.fn(async () => undefined),
  }),
}));

import { FrogWidgetPage } from '../FrogWidgetPage';

describe('FrogWidgetPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('starts the Frog compile queue with wiki compilation enabled', async () => {
    render(<FrogWidgetPage />);

    fireEvent.click(screen.getAllByRole('button')[0]);
    fireEvent.click(screen.getByRole('button', { name: /编译队列/ }));

    await waitFor(() => {
      expect(rawAssetMocks.processRawAssetQueue).toHaveBeenCalledTimes(1);
    });
    expect(rawAssetMocks.processRawAssetQueue.mock.calls[0]?.[0]).toMatchObject({
      owner: 'frog',
      compileWiki: true,
    });
    expect(rawAssetMocks.processRawAssetQueue.mock.calls[0]?.[0]).toHaveProperty('onStatus', expect.any(Function));
  });
});
