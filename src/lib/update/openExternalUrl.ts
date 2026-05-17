import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '@/lib/runtime/tauri';

export async function openExternalUrl(url: string) {
  const target = normalizeHttpUrl(url);
  if (isTauriRuntime()) {
    await invoke('open_external_url', { url: target });
    return;
  }

  const opened = window.open(target, '_blank', 'noopener,noreferrer');
  if (!opened) window.location.assign(target);
}

function normalizeHttpUrl(url: string) {
  const parsed = new URL(url.trim());
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only HTTP(S) update links can be opened.');
  }
  return parsed.toString();
}
