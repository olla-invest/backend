import type { ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import { useAuth } from '../auth';
import { ROLE_LABELS } from '../format';
import type { Route } from '../router';

const MENU: Array<{ section: Route['name']; label: string; href: string }> = [
  { section: 'dashboard', label: '서비스 현황', href: '#/dashboard' },
  { section: 'members', label: '회원관리', href: '#/members' },
  { section: 'service', label: '서비스 관리', href: '#/service' },
];

export function Logo() {
  return (
    <span className="logo" aria-label="olla">
      ol<span className="logo-accent">l</span>a
    </span>
  );
}

export function Layout({ route, children }: { route: Route; children: ReactNode }) {
  const { admin, logout } = useAuth();
  const active = route.name === 'memberDetail' ? 'members' : route.name;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <Logo />
        </div>
        <nav className="sidebar-menu">
          {MENU.map((item) => (
            <a key={item.section} href={item.href} className={`menu-item${active === item.section ? ' is-active' : ''}`}>
              {item.label}
            </a>
          ))}
        </nav>
        {admin && (
          <div className="sidebar-account">
            <div>
              <strong>{admin.name || admin.loginId}</strong>
              <span>{ROLE_LABELS[admin.role]}</span>
            </div>
            <button type="button" className="icon-button" aria-label="로그아웃" title="로그아웃" onClick={logout}>
              <LogOut size={18} />
            </button>
          </div>
        )}
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
