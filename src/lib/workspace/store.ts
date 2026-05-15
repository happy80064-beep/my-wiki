import { create } from 'zustand';
import type { WorkspaceSnapshot } from './service';
import { clearPersistedWorkspaceRoot, getPersistedWorkspaceRoot, persistWorkspaceRoot } from './activeWorkspace';
import {
  buildWorkspaceRegistryInputFromSnapshot,
  loadWorkspaceRegistry,
  removeWorkspaceRegistryItem,
  upsertWorkspaceRegistryItem,
  type WorkspaceRegistryInput,
  type WorkspaceRegistryItem,
} from './registry';

type WorkspaceRuntimeState = {
  activeRoot: string | null;
  snapshot: WorkspaceSnapshot | null;
  knownWorkspaces: WorkspaceRegistryItem[];
  setActiveWorkspace: (root: string, snapshot: WorkspaceSnapshot, meta?: Partial<WorkspaceRegistryInput>) => void;
  registerWorkspace: (input: WorkspaceRegistryInput) => void;
  removeRegisteredWorkspace: (root: string) => void;
  refreshWorkspaceRegistry: () => void;
  clearActiveWorkspace: () => void;
};

export const useWorkspaceRuntimeStore = create<WorkspaceRuntimeState>((set) => ({
  activeRoot: getPersistedWorkspaceRoot(),
  snapshot: null,
  knownWorkspaces: loadWorkspaceRegistry(),
  setActiveWorkspace(root, snapshot, meta) {
    persistWorkspaceRoot(root);
    const knownWorkspaces = upsertWorkspaceRegistryItem(buildWorkspaceRegistryInputFromSnapshot(root, snapshot, meta));
    set({ activeRoot: root, snapshot, knownWorkspaces });
  },
  registerWorkspace(input) {
    const knownWorkspaces = upsertWorkspaceRegistryItem(input);
    set({ knownWorkspaces });
  },
  removeRegisteredWorkspace(root) {
    const knownWorkspaces = removeWorkspaceRegistryItem(root);
    set({ knownWorkspaces });
  },
  refreshWorkspaceRegistry() {
    set({ knownWorkspaces: loadWorkspaceRegistry() });
  },
  clearActiveWorkspace() {
    clearPersistedWorkspaceRoot();
    set({ activeRoot: null, snapshot: null });
  },
}));
