const CLIENT_ID_KEY = 'mywiki.clientId';

let fallbackClientId: string | undefined;

export function getClientId() {
  const storage = getLocalStorage();
  const existing = storage?.getItem(CLIENT_ID_KEY);
  if (existing) return existing;

  const clientId = fallbackClientId ?? `desktop-${crypto.randomUUID()}`;
  fallbackClientId = clientId;
  storage?.setItem(CLIENT_ID_KEY, clientId);
  return clientId;
}

function getLocalStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
