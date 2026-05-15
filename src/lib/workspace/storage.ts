import { isTauriRuntime } from '@/lib/runtime/tauri';
import { createDevWorkspaceStorage, getDevDefaultWorkspaceRoot } from './devStorage';
import { createTauriWorkspaceStorage, getDefaultWorkspaceRoot, type TauriWorkspaceStorage } from './tauriStorage';

export function canUseWorkspaceStorage() {
  return isTauriRuntime() || isLocalDevWorkspaceRuntime();
}

export function createWorkspaceStorage(): TauriWorkspaceStorage {
  if (isTauriRuntime()) return createTauriWorkspaceStorage();
  if (isLocalDevWorkspaceRuntime()) return createDevWorkspaceStorage();
  throw new Error('文件工作区需要桌面壳，或通过 localhost:5173 开发服务运行。');
}

export function getWorkspaceDefaultRoot() {
  if (isTauriRuntime()) return getDefaultWorkspaceRoot();
  if (isLocalDevWorkspaceRuntime()) return getDevDefaultWorkspaceRoot();
  throw new Error('文件工作区需要桌面壳，或通过 localhost:5173 开发服务运行。');
}

function isLocalDevWorkspaceRuntime() {
  if (typeof window === 'undefined') return false;
  if (!import.meta.env.DEV) return false;
  const host = window.location.hostname;
  return (host === 'localhost' || host === '127.0.0.1') && window.location.port === '5173';
}
