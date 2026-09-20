import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import Login from './components/Login';
import TrainManager from './components/TrainManager';
import TrainSchedules from './components/TrainSchedules';
import Dashboard from './components/Dashboard';
import ExceptionsManager from './components/ExceptionsManager';
import ArticlesManager from './components/ArticlesManager';
import ThemeToggle from './components/ThemeToggle';
import PasswordModal from './components/PasswordModal';
import { FEATURES } from './features';
import type { Overview } from './types';
import {
  LayoutDashboard, TrainFront, BookOpen, Route, CalendarDays, LogOut, KeyRound,
  type LucideIcon,
} from 'lucide-react';

type View = 'dashboard' | 'guide' | 'trains' | 'exceptions' | 'articles';
type Role = 'admin' | 'author';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [role, setRole] = useState<Role>('admin');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [currentView, setCurrentView] = useState<View>('dashboard');
  const [checking, setChecking] = useState(true);
  const [showPassword, setShowPassword] = useState(false);

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
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    measure();
    const raf = requestAnimationFrame(() => setIndicatorReady(true));
    window.addEventListener('resize', measure);
    document.fonts?.ready.then(measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
    };
  }, [currentView, isAuthenticated, checking]);

  // A new view starts at the top, like a new page would.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
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
    return () => window.clearInterval(id);
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

  const navBtn = (view: View, label: string, Icon: LucideIcon) => (
    <button
      onClick={() => setCurrentView(view)}
      aria-current={currentView === view ? 'page' : undefined}
      className="nav-item md:w-full"
    >
      <Icon size={17} strokeWidth={2} aria-hidden="true" />
      {label}
    </button>
  );

  return (
    <div className="md:flex md:h-screen">
      <aside className="flex shrink-0 flex-col border-b border-line bg-surface md:h-full md:w-64 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-3 px-5 pb-4 pt-5">
          <div className="brand">
            <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" className="brand-mark" />
            <div>
              <div className="brand-name">BulTrain</div>
              <div className="brand-sub">{isAdmin ? 'Админ панел' : 'Автор на статии'}</div>
            </div>
          </div>
          <div className="md:hidden"><ThemeToggle /></div>
        </div>

        <nav ref={navRef} aria-label="Навигация" className="relative flex gap-1 overflow-x-auto px-3 pb-3 [scrollbar-width:none] md:flex-1 md:flex-col md:overflow-visible">
          <span
            aria-hidden="true"
            className="nav-indicator"
            data-ready={indicator && indicatorReady ? '' : undefined}
            style={indicator ? { transform: `translate(${indicator.x}px, ${indicator.y}px)`, width: indicator.w, height: indicator.h } : undefined}
          />
          {isAdmin && navBtn('dashboard', 'Общ изглед', LayoutDashboard)}
          {isAdmin && navBtn('trains', 'Влакове и разписания', TrainFront)}
          {isAdmin && navBtn('guide', 'Справочник', BookOpen)}
          {navBtn('articles', 'Идеи за пътуване', Route)}
          {isAdmin && FEATURES.exceptions && navBtn('exceptions', 'Празници / изключения', CalendarDays)}
          <button onClick={() => setShowPassword(true)} className="nav-item md:hidden">
            <KeyRound size={17} strokeWidth={2} aria-hidden="true" />
            Парола
          </button>
          <button onClick={handleLogout} className="nav-item md:hidden">
            <LogOut size={17} strokeWidth={2} aria-hidden="true" />
            Изход
          </button>
        </nav>

        {overview && (
          <dl className="mx-5 hidden space-y-2 border-t border-line py-4 text-[0.8125rem] md:block">
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

        <div className="hidden border-t border-line p-3 md:block">
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

      <main ref={mainRef} className="w-full flex-1 md:overflow-y-auto">
        <div key={currentView} className="mx-auto max-w-5xl px-5 py-6 md:px-10 md:py-10">
          {isAdmin && currentView === 'dashboard' && <Dashboard overview={overview} />}
          {isAdmin && currentView === 'guide' && <ArticlesManager category="guide" />}
          {isAdmin && currentView === 'trains' && (FEATURES.legacyTrainEditor ? <TrainManager /> : <TrainSchedules />)}
          {isAdmin && FEATURES.exceptions && currentView === 'exceptions' && <ExceptionsManager />}
          {currentView === 'articles' && <ArticlesManager />}
        </div>
      </main>

      {showPassword && <PasswordModal onClose={() => setShowPassword(false)} />}
    </div>
  );
}

export default App;
