import { useEffect } from 'react';
import { Brain } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';
import { UpdateBanner } from '@/components/update/UpdateBanner';
import { checkForUpdates, getAppUpdateConfig, UPDATE_CHECK_CACHE_MS } from '@/lib/update/updateCheck';
import {
  hasAvailableUpdate,
  loadUpdateCheckState,
  saveUpdateCheckState,
  useUpdateStore,
} from '@/lib/update/updateStore';

const navItems = [
  { to: '/', label: '总览' },
  { to: '/capture', label: '捕获' },
  { to: '/wiki', label: '知识库' },
  { to: '/graph', label: '图谱' },
  { to: '/reviews', label: '审核' },
  { to: '/lint', label: '巡检' },
  { to: '/query', label: '查询' },
  { to: '/settings', label: '设置' },
  { to: '/about', label: '关于' },
];

export function App() {
  const updateAvailable = useUpdateStore((state) => hasAvailableUpdate(state));

  useEffect(() => {
    const persisted = loadUpdateCheckState();
    useUpdateStore.getState().hydrate(persisted);

    const timer = window.setTimeout(() => {
      void runStartupUpdateCheck();
    }, 1500);

    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-[#f7f7f5] text-[#222222]">
      <header className="shrink-0 border-b border-[#e5e5e4] bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-[10px] border border-[#d9d9d6] bg-[#f4f8ff] text-[#155eef]">
              <Brain size={19} strokeWidth={2} />
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-normal">MyWiki</h1>
              <p className="text-xs text-[#6b6b68]">个人 AI 知识中枢 MVP</p>
            </div>
          </div>
          <nav className="flex items-center gap-1 rounded-full border border-[#d9d9d6] bg-[#f7f7f5] p-1">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                title={item.to === '/about' && updateAvailable ? '发现新版本，点击查看更新' : item.label}
                className={({ isActive }) =>
                  [
                    'rounded-full px-3 py-1.5 text-xs transition',
                    isActive ? 'bg-white text-[#155eef]' : 'text-[#5f625f] hover:text-[#222222]',
                  ].join(' ')
                }
              >
                <span className="relative inline-flex items-center">
                  {item.label}
                  {item.to === '/about' && updateAvailable ? (
                    <span className="absolute -right-1.5 -top-1.5 size-2 rounded-full bg-[#ef4444]" aria-label="有新版本可用" />
                  ) : null}
                </span>
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <UpdateBanner />

      <div className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </div>
    </main>
  );
}

async function runStartupUpdateCheck() {
  const state = useUpdateStore.getState();
  const config = getAppUpdateConfig();
  if (!state.enabled || state.checking || !config.repo.trim()) return;
  if (state.lastCheckedAt && Date.now() - state.lastCheckedAt < UPDATE_CHECK_CACHE_MS) return;

  useUpdateStore.getState().setChecking(true);
  const result = await checkForUpdates(config);
  const now = Date.now();
  useUpdateStore.getState().setResult(result, now);
  saveUpdateCheckState({
    enabled: useUpdateStore.getState().enabled,
    lastCheckedAt: now,
    dismissedVersion: useUpdateStore.getState().dismissedVersion,
  });
}
