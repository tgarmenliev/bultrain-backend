import { useState, useEffect } from 'react';
import Login from './components/Login';
import GuideManager from './components/GuideManager';
import TrainManager from './components/TrainManager';
import DataSync from './components/DataSync';
import ExceptionsManager from './components/ExceptionsManager';

type View = 'dashboard' | 'guide' | 'trains' | 'exceptions';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [stats, setStats] = useState<{ trains: number; stations: number; guideTopics: number } | null>(null);
  const [currentView, setCurrentView] = useState<View>('dashboard');

  // Check auth status on mount by attempting to fetch stats
  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const response = await fetch('/api/admin/stats');
      if (response.ok) {
        const data = await response.json();
        setStats(data);
        setIsAuthenticated(true);
      } else {
        setIsAuthenticated(false);
      }
    } catch (error) {
      console.error('Failed to fetch stats:', error);
      setIsAuthenticated(false);
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

  if (!isAuthenticated) {
    return <Login onLoginSuccess={fetchStats} />;
  }

  return (
    <div className="h-screen w-full flex overflow-hidden text-slate-100 font-sans animate-in-fade">
      {/* Sidebar */}
      <aside className="w-72 h-full glassmorphism border-r border-white/5 flex flex-col z-20 shrink-0">
        <div className="p-6 pb-4">
          <h1 className="text-2xl font-black text-gradient-brand tracking-tight">Админ Панел</h1>
          <p className="text-slate-400 text-sm mt-1 font-medium">Система за Управление</p>
        </div>

        <nav className="flex-1 space-y-2 px-6">
          <button
            onClick={() => setCurrentView('dashboard')}
            className={`w-full text-left px-4 py-3 rounded-xl font-bold tracking-wide transition-all duration-300 ${currentView === 'dashboard' ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 shadow-[0_0_15px_rgba(99,102,241,0.15)]' : 'text-slate-400 hover:bg-slate-800/50 hover:text-white border border-transparent'
              }`}
          >
            Общ изглед
          </button>
          <button
            onClick={() => setCurrentView('trains')}
            className={`w-full text-left px-4 py-3 rounded-xl font-bold tracking-wide transition-all duration-300 ${currentView === 'trains' ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 shadow-[0_0_15px_rgba(99,102,241,0.15)]' : 'text-slate-400 hover:bg-slate-800/50 hover:text-white border border-transparent'
              }`}
          >
            Влакове и Разписания
          </button>
          <button
            onClick={() => setCurrentView('guide')}
            className={`w-full text-left px-4 py-3 rounded-xl font-bold tracking-wide transition-all duration-300 ${currentView === 'guide' ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 shadow-[0_0_15px_rgba(99,102,241,0.15)]' : 'text-slate-400 hover:bg-slate-800/50 hover:text-white border border-transparent'
              }`}
          >
            Справочник
          </button>
          <button
            onClick={() => setCurrentView('exceptions')}
            className={`w-full text-left px-4 py-3 rounded-xl font-bold tracking-wide transition-all duration-300 ${currentView === 'exceptions' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 shadow-[0_0_15px_rgba(245,158,11,0.15)]' : 'text-slate-400 hover:bg-slate-800/50 hover:text-white border border-transparent'
              }`}
          >
            Празници / Изключения
          </button>
        </nav>

        {/* Sidebar Stats Area */}
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
          {currentView === 'dashboard' && (
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

          {currentView === 'guide' && <GuideManager />}
          {currentView === 'trains' && <TrainManager />}
          {currentView === 'exceptions' && <ExceptionsManager />}
        </div>
      </main>
    </div>
  );
}

export default App;
