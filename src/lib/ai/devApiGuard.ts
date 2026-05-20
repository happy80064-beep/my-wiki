export function assertDevAiApiAvailable(featureName: string) {
  if (import.meta.env.DEV) return;

  throw new Error(
    `${featureName} 当前使用本地 Vite dev API 中转，只能在开发模式运行。` +
      '生产桌面版需要先把 LLM 调用迁移到 Tauri/Rust side 或本地 sidecar，并使用系统凭据库存储 API key。',
  );
}

export function buildDevApiUrl(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const base = getDevApiBaseUrl();
  return base ? `${base}${normalizedPath}` : normalizedPath;
}

function getDevApiBaseUrl() {
  const envBase =
    import.meta.env.VITE_MYWIKI_DEV_API_BASE ||
    (typeof process !== 'undefined' ? process.env.REAL_QUERY_API_BASE || process.env.MYWIKI_DEV_API_BASE : '');
  return typeof envBase === 'string' ? envBase.replace(/\/$/, '') : '';
}
