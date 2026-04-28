import { Brain } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';

const navItems = [
  { to: '/', label: '总览' },
  { to: '/capture', label: '捕获' },
  { to: '/wiki', label: '知识库' },
  { to: '/query', label: '查询' },
];

export function App() {
  return (
    <main className="min-h-screen bg-[#f7f7f5] text-[#222222]">
      <header className="border-b border-[#e5e5e4] bg-white">
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
                className={({ isActive }) =>
                  [
                    'rounded-full px-3 py-1.5 text-xs transition',
                    isActive ? 'bg-white text-[#155eef]' : 'text-[#5f625f] hover:text-[#222222]',
                  ].join(' ')
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <Outlet />
    </main>
  );
}
