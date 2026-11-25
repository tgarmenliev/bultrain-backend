import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import Login from './components/Login';
import TrainManager from './components/TrainManager';
import TrainSchedules from './components/TrainSchedules';
import Dashboard from './components/Dashboard';
import ExceptionsManager from './components/ExceptionsManager';
import ArticlesManager from './components/ArticlesManager';
import DistanceCalculator from './components/DistanceCalculator';
import ThemeToggle from './components/ThemeToggle';
import PasswordModal from './components/PasswordModal';
import MobileMenu from './components/MobileMenu';
import { DESKTOP, useMediaQuery } from './useMediaQuery';
import { FEATURES } from './features';
import type { Overview } from './types';
import {
  LayoutDashboard, TrainFront, BookOpen, Route, CalendarDays, LogOut, KeyRound, Ruler, CircleUserRound,
  type LucideIcon,
} from 'lucide-react';

type View = 'dashboard' | 'guide' | 'trains' | 'exceptions' | 'articles' | 'distance';
type Role = 'admin' | 'author';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [role, setRole] = useState<Role>('admin');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [currentView, setCurrentView] = useState<View>('dashboard');
  const [checking, setChecking] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  // An open article editor takes the bottom of a phone screen for its own buttons.
  const [editing, setEditing] = useState(false);
  const desktop = useMediaQuery(DESKTOP);

  const navRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [indicatorReady, setIndicatorReady] = useState(false);

  useEffect(() => {
    checkAuth();
  }, []);

  // Slide the highlight to whichever nav item is current. The first placement
  // is not animated (it only becomes visible one frame later), so the pill
  // never sweeps in from the corner on load.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const el = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!el) return;
      setIndicator({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    };
    measure();
    const raf = requestAnimationFrame(() => setIndicatorReady(true));
    window.addEventListener('resize', measure);
    document.fonts?.ready.then(measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
    };
  }, [currentView, isAuthenticated, checking, desktop]);

  // A new view starts at the top, like a new page would. On the desktop layout
  // <main> scrolls; on a phone the page itself does.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    window.scrollTo(0, 0);
  }, [currentView]);

  // Auth is decided by /me (any account), NOT the admin-only /overview — so an
  // author passes the gate. Admins additionally load the dashboard overview.
  const checkAuth = async () => {
    try {
      const res = await fetch('/api/admin/me');
      if (!res.ok) { setIsAuthenticated(false); return; }
      const me = await res.json();
      const r: Role = me.role === 'author' ? 'author' : 'admin';
      setRole(r);
      setUsername(typeof me.username === 'string' ? me.username : null);
      setIsAuthenticated(true);
      setCurrentView(r === 'author' ? 'articles' : 'dashboard');
    } catch {
      setIsAuthenticated(false);
    } finally {
      setChecking(false);
    }
  };

  const fetchOverview = async () => {
    try {
      const response = await fetch('/api/admin/overview');
      if (response.ok) setOverview(await response.json());
    } catch (error) {
      console.error('Failed to fetch overview:', error);
    }
  };

  // The overview is live data (realtime health, tracking, today's trains): load
  // it on landing and refresh it every minute while the overview is on screen.
  useEffect(() => {
    if (!isAuthenticated || role !== 'admin' || currentView !== 'dashboard') return;
    fetchOverview();
    const id = window.setInterval(fetchOverview, 60_000);
    // A phone suspends the timer in the background: catch up on coming back.
    const onVisible = () => { if (document.visibilityState === 'visible') fetchOverview(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isAuthenticated, role, currentView]);

  const handleLogout = async () => {
    try {
      await fetch('/api/admin/logout', { method: 'POST' });
      setIsAuthenticated(false);
      setOverview(null);
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  if (checking) return null;
  if (!isAuthenticated) return <Login onLoginSuccess={checkAuth} />;

  const isAdmin = role === 'admin';

  // One list for both layouts; `short` is what fits under a phone tab's icon.
  const items: { view: View; label: string; short: string; Icon: LucideIcon }[] = [
    ...(isAdmin ? [
      { view: 'dashboard' as const, label: 'Общ изглед', short: 'Преглед', Icon: LayoutDashboard },
      { view: 'trains' as const, label: 'Влакове и разписания', short: 'Влакове', Icon: TrainFront },
      { view: 'distance' as const, label: 'Разстояния', short: 'Разстояния', Icon: Ruler },
      { view: 'guide' as const, label: 'Справочник', short: 'Справочник', Icon: BookOpen },
    ] : []),
    { view: 'articles', label: 'Идеи за пътуване', short: 'Идеи', Icon: Route },
    ...(isAdmin && FEATURES.exceptions
      ? [{ view: 'exceptions' as const, label: 'Празници / изключения', short: 'Празници', Icon: CalendarDays }]
      : []),
  ];

  const brand = (
    <div className="brand">
      <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" className="brand-mark" />
      <div>
        <div className="brand-name">BulTrain</div>
        <div className="brand-sub">{isAdmin ? 'Админ панел' : 'Автор на статии'}</div>
      </div>
    </div>
  );

  // The sidebar and the top bar are swapped, never <main>: turning the phone
  // keeps whatever is open in it, including a half-written article.
  return (
    <div className="desktop:flex desktop:h-screen">
      {desktop ? (
        <aside className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-surface">
          <div className="px-5 pb-4 pt-5">{brand}</div>

          <nav ref={navRef} aria-label="Навигация" className="relative flex flex-1 flex-col gap-1 px-3 pb-3">
            <span
              aria-hidden="true"
              className="nav-indicator"
              data-ready={indicator && indicatorReady ? '' : undefined}
              style={indicator ? { transform: `translate(${indicator.x}px, ${indicator.y}px)`, width: indicator.w, height: indicator.h } : undefined}
            />
            {items.map(({ view, label, Icon }) => (
              <button
                key={view}
                onClick={() => setCurrentView(view)}
                aria-current={currentView === view ? 'page' : undefined}
                className="nav-item w-full"
              >
                <Icon size={17} strokeWidth={2} aria-hidden="true" />
                {label}
              </button>
            ))}
          </nav>

          {overview && (
            <dl className="mx-5 space-y-2 border-t border-line py-4 text-[0.8125rem]">
              <div className="flex items-baseline justify-between">
                <dt className="text-muted">Влакове</dt>
                <dd className="num font-semibold">{overview.trains}</dd>
              </div>
              <div className="flex items-baseline justify-between">
                <dt className="text-muted">Гари</dt>
                <dd className="num font-semibold">{overview.stations}</dd>
              </div>
            </dl>
          )}

          <div className="border-t border-line p-3">
            <button onClick={() => setShowPassword(true)} className="btn btn-ghost btn-sm w-full justify-start">
              <KeyRound size={15} strokeWidth={2} aria-hidden="true" />
              Смяна на парола
            </button>
            <div className="mt-1 flex items-center justify-between gap-2">
              <button onClick={handleLogout} className="btn btn-ghost btn-sm">
                <LogOut size={15} strokeWidth={2} aria-hidden="true" />
                Изход
              </button>
              <ThemeToggle />
            </div>
          </div>
        </aside>
      ) : (
        <header className="app-bar">
          {brand}
          <button onClick={() => setShowMenu(true)} aria-label="Меню" className="btn btn-ghost btn-icon">
            <CircleUserRound size={22} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>
      )}

      <main ref={mainRef} className="w-full min-w-0 flex-1 desktop:overflow-y-auto">
        <div key={currentView} className="page mx-auto max-w-5xl">
          {isAdmin && currentView === 'dashboard' && <Dashboard overview={overview} />}
          {isAdmin && currentView === 'distance' && <DistanceCalculator />}
          {isAdmin && currentView === 'guide' && <ArticlesManager category="guide" onEditingChange={setEditing} />}
          {isAdmin && currentView === 'trains' && (FEATURES.legacyTrainEditor ? <TrainManager /> : <TrainSchedules />)}
          {isAdmin && FEATURES.exceptions && currentView === 'exceptions' && <ExceptionsManager />}
          {currentView === 'articles' && <ArticlesManager onEditingChange={setEditing} />}
        </div>
      </main>

      {!desktop && !editing && items.length > 1 && (
        <nav aria-label="Навигация" className="tab-bar">
          {items.map(({ view, short, Icon }) => (
            <button
              key={view}
              onClick={() => { setCurrentView(view); window.scrollTo(0, 0); }}
              aria-current={currentView === view ? 'page' : undefined}
              className="tab-item"
            >
              <span><Icon size={20} strokeWidth={2} aria-hidden="true" /></span>
              <span>{short}</span>
            </button>
          ))}
        </nav>
      )}

      {showMenu && !desktop && (
        <MobileMenu
          username={username}
          onClose={() => setShowMenu(false)}
          onPassword={() => { setShowMenu(false); setShowPassword(true); }}
          onLogout={() => { setShowMenu(false); handleLogout(); }}
        />
      )}
      {showPassword && <PasswordModal onClose={() => setShowPassword(false)} />}
    </div>
  );
}

export default App;
