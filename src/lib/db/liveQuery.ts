import { useEffect, useState } from 'react';

type Listener = () => void;

const listeners = new Set<Listener>();

export function notifyWorkspaceDbChanged() {
  for (const listener of listeners) listener();
}

export function useLiveQuery<T>(querier: () => Promise<T> | T, deps?: unknown[]): T | undefined;
export function useLiveQuery<T, TDefault>(
  querier: () => Promise<T> | T,
  deps: unknown[],
  defaultResult: TDefault,
): T | TDefault;
export function useLiveQuery<T, TDefault>(
  querier: () => Promise<T> | T,
  deps: unknown[] = [],
  defaultResult?: TDefault,
): T | TDefault | undefined {
  const [value, setValue] = useState<T | TDefault | undefined>(defaultResult);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      Promise.resolve()
        .then(querier)
        .then((next) => {
          if (!cancelled) {
            setError(null);
            setValue(next);
          }
        })
        .catch((nextError) => {
          if (!cancelled) setError(nextError);
        });
    };

    listeners.add(run);
    run();
    return () => {
      cancelled = true;
      listeners.delete(run);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  if (error) throw error;
  return value;
}
