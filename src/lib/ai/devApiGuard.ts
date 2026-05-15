export function assertDevAiApiAvailable(featureName: string) {
  if (import.meta.env.DEV) return;

  throw new Error(
    `${featureName} 当前使用本地 Vite dev API 中转，只能在开发模式运行。` +
      '生产桌面版需要先把 LLM 调用迁移到 Tauri/Rust side 或本地 sidecar，并使用系统凭据库存储 API key。',
  );
}
