import { useState, useEffect } from 'react';
import Login from './components/Login';
import TrainManager from './components/TrainManager';
import DataSync from './components/DataSync';
import ExceptionsManager from './components/ExceptionsManager';
import ArticlesManager from './components/ArticlesManager';

type View = 'dashboard' | 'guide' | 'trains' | 'exceptions' | 'articles';
type Role = 'admin' | 'author';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [role, setRole] = useState<Role>('admin');
  const [stats, setStats] = useState<{ trains: number; stations: number; guideTopics: number } | null>(null);
  const [currentView, setCurrentView] = useState<View>('dashboard');
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    checkAuth();
  }, []);

  // Auth is decided by /me (any account), NOT the admin-only /stats — so an
  // author passes the gate. Admins additionally pull the dashboard stats.
  const checkAuth = async () => {
    try {
      const res = await fetch('/api/admin/me');
      if (!res.ok) { setIsAuthenticated(false); return; }
      const me = await res.json();
      const r: Role = me.role === 'author' ? 'author' : 'admin';
      setRole(r);
      setIsAuthenticated(true);
      setCurrentView(r === 'author' ? 'articles' : 'dashboard');
      if (r === 'admin') fetchStats();
    } catch {
      setIsAuthenticated(false);
    } finally {
      setChecking(false);
    }
  };

  const fetchStats = async () => {
    try {
      const response = await fetch('/api/admin/stats');
      if (response.ok) setStats(await response.json());
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/admin/logout', { method: 'POST' });
      setIsAuthenticated(false);
      setStats(null);
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  if (checking) return null;
  if (!isAuthenticated) return <Login onLoginSuccess={checkAuth} />;

  const isAdmin = role === 'admin';
  // Fixed classes only — Tailwind can't generate class names built from variables.
  const navBtn = (view: View, label: string) => (
    <button
      onClick={() => setCurrentView(view)}
      className={`w-full text-left px-4 py-3 rounded-xl font-bold tracking-wide transition-all duration-300 ${currentView === view
        ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 shadow-[0_0_15px_rgba(99,102,241,0.15)]'
        : 'text-slate-400 hover:bg-slate-800/50 hover:text-white border border-transparent'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="h-screen w-full flex overflow-hidden text-slate-100 font-sans animate-in-fade">
      <aside className="w-72 h-full glassmorphism border-r border-white/5 flex flex-col z-20 shrink-0">
        <div className="p-6 pb-4">
          <h1 className="text-2xl font-black text-gradient-brand tracking-tight">Админ Панел</h1>
          <p className="text-slate-400 text-sm mt-1 font-medium">
            {isAdmin ? 'Система за Управление' : 'Автор на статии'}
          </p>
        </div>

        <nav className="flex-1 space-y-2 px-6">
          {isAdmin && navBtn('dashboard', 'Общ изглед')}
          {isAdmin && navBtn('trains', 'Влакове и Разписания')}
          {isAdmin && navBtn('guide', 'Справочник')}
          {navBtn('articles', 'Идеи за пътуване')}
          {isAdmin && navBtn('exceptions', 'Празници / Изключения')}
        </nav>

        {stats && (
          <div className="px-6 pb-6 mt-4">
            <div className="p-4 bg-slate-900/40 rounded-2xl border border-white/5 shadow-inner">
              <h3 className="text-[10px] font-black tracking-widest text-slate-500 mb-3 uppercase">Текущи данни</h3>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-semibold text-slate-400">Влакове</span>
                  <span className="text-sm font-black text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded-md border border-indigo-500/20">{stats.trains}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs font-semibold text-slate-400">Гари</span>
                  <span className="text-sm font-black text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded-md border border-cyan-500/20">{stats.stations}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="p-6 pt-0 mt-auto">
          <button
            onClick={handleLogout}
            className="w-full px-4 py-3 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 rounded-xl text-sm font-bold transition-all duration-300 border border-rose-500/20 hover:border-rose-500/40 hover:shadow-[0_0_15px_rgba(244,63,94,0.15)]"
          >
            Изход
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto w-full relative z-10 custom-scrollbar">
        <div className="p-8 md:p-12 max-w-6xl mx-auto animate-in-fade" style={{ animationDelay: '0.1s' }}>
          {isAdmin && currentView === 'dashboard' && (
            <div className="space-y-8">
              <div>
                <h2 className="text-3xl font-bold text-gradient">Общ изглед</h2>
                <p className="text-slate-400 text-sm mt-2">Системна статистика и обобщение.</p>
              </div>
              <DataSync />
              <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="p-8 glass-card rounded-2xl cursor-default group hover:shadow-indigo-500/10 hover:border-indigo-500/30">
                  <h2 className="text-slate-400 text-sm font-semibold mb-3 tracking-wide uppercase">Общо Влакове</h2>
                  <p className="text-5xl font-black text-white group-hover:text-indigo-400 transition-colors">{stats?.trains || 0}</p>
                </div>
                <div className="p-8 glass-card rounded-2xl cursor-default group hover:shadow-cyan-500/10 hover:border-cyan-500/30">
                  <h2 className="text-slate-400 text-sm font-semibold mb-3 tracking-wide uppercase">Общо Гари</h2>
                  <p className="text-5xl font-black text-white group-hover:text-cyan-400 transition-colors">{stats?.stations || 0}</p>
                </div>
                <div className="p-8 glass-card rounded-2xl cursor-default group hover:shadow-purple-500/10 hover:border-purple-500/30">
                  <h2 className="text-slate-400 text-sm font-semibold mb-3 tracking-wide uppercase">Теми в Справочника</h2>
                  <p className="text-5xl font-black text-white group-hover:text-purple-400 transition-colors">{stats?.guideTopics || 0}</p>
                </div>
              </section>
            </div>
          )}

          {isAdmin && currentView === 'guide' && <ArticlesManager category="guide" />}
          {isAdmin && currentView === 'trains' && <TrainManager />}
          {isAdmin && currentView === 'exceptions' && <ExceptionsManager />}
          {currentView === 'articles' && <ArticlesManager />}
        </div>
      </main>
    </div>
  );
}

export default App;
