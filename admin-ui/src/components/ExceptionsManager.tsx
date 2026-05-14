import { useState, useEffect } from 'react';

interface ScheduleException {
    exception_date: string;
    schedule_type_override: string;
}

const DAY_OPTIONS = [
    { value: 'monday',    label: 'Понеделник (делник)' },
    { value: 'tuesday',   label: 'Вторник (делник)' },
    { value: 'wednesday', label: 'Сряда (делник)' },
    { value: 'thursday',  label: 'Четвъртък (делник)' },
    { value: 'friday',    label: 'Петък (делник)' },
    { value: 'saturday',  label: 'Събота' },
    { value: 'sunday',    label: 'Неделя' },
];

const DAY_LABELS: Record<string, string> = {
    monday: 'Понеделник', tuesday: 'Вторник', wednesday: 'Сряда',
    thursday: 'Четвъртък', friday: 'Петък', saturday: 'Събота', sunday: 'Неделя',
};

const BADGE_COLORS: Record<string, string> = {
    saturday: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20',
    sunday:   'bg-purple-500/10 text-purple-300 border-purple-500/20',
    monday: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
    tuesday: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
    wednesday: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
    thursday: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
    friday: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
};

export default function ExceptionsManager() {
    const [exceptions, setExceptions] = useState<ScheduleException[]>([]);
    const [loading, setLoading] = useState(true);
    const [formDate, setFormDate] = useState('');
    const [formOverride, setFormOverride] = useState('sunday');
    const [formError, setFormError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const fetchExceptions = async () => {
        try {
            setLoading(true);
            const res = await fetch('/api/admin/exceptions');
            if (!res.ok) throw new Error();
            setExceptions(await res.json());
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchExceptions(); }, []);

    const handleAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        setFormError('');
        setSubmitting(true);
        try {
            const res = await fetch('/api/admin/exceptions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ exception_date: formDate, schedule_type_override: formOverride }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Грешка');
            setFormDate('');
            await fetchExceptions();
        } catch (err: any) {
            setFormError(err.message);
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (date: string) => {
        if (!window.confirm(`Изтриване на изключение за ${date}?`)) return;
        await fetch(`/api/admin/exceptions/${date}`, { method: 'DELETE' });
        setExceptions(prev => prev.filter(e => e.exception_date !== date));
    };

    return (
        <div className="space-y-8 animate-in-fade" style={{ animationDelay: '0.2s' }}>
            <div>
                <h2 className="text-3xl font-bold text-gradient">Празници и Изключения</h2>
                <p className="text-slate-400 text-sm mt-2">
                    Задайте конкретна дата да използва различен тип разписание (напр. национален празник → неделно разписание).
                </p>
            </div>

            {/* Add form */}
            <div className="glass-card rounded-2xl p-6">
                <h3 className="text-sm font-black uppercase tracking-widest text-slate-400 mb-5">Добави изключение</h3>
                <form onSubmit={handleAdd} className="flex flex-wrap gap-4 items-end">
                    <div className="space-y-2 flex-1 min-w-[160px]">
                        <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Дата</label>
                        <input
                            type="date"
                            required
                            value={formDate}
                            onChange={e => setFormDate(e.target.value)}
                            className="input-premium w-full"
                        />
                    </div>
                    <div className="space-y-2 flex-1 min-w-[200px]">
                        <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Тип разписание</label>
                        <select
                            value={formOverride}
                            onChange={e => setFormOverride(e.target.value)}
                            className="input-premium w-full"
                        >
                            {DAY_OPTIONS.map(o => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                        </select>
                    </div>
                    <button
                        type="submit"
                        disabled={submitting}
                        className="btn-glow px-6 py-3 disabled:opacity-50 shrink-0"
                    >
                        {submitting ? 'Запазване...' : 'Добави'}
                    </button>
                </form>
                {formError && (
                    <p className="mt-3 text-sm text-rose-400 font-medium">{formError}</p>
                )}
            </div>

            {/* Exceptions table */}
            <div className="glass-card rounded-2xl overflow-hidden">
                <table className="w-full text-left text-sm text-slate-300">
                    <thead className="bg-slate-950/80 backdrop-blur-md text-slate-400 border-b border-slate-800 uppercase text-xs tracking-wider">
                        <tr>
                            <th className="px-6 py-4 font-medium">Дата</th>
                            <th className="px-6 py-4 font-medium">Тип разписание</th>
                            <th className="px-6 py-4 font-medium text-right">Действия</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                        {loading && (
                            <tr>
                                <td colSpan={3} className="px-6 py-10 text-center text-slate-500">Зареждане...</td>
                            </tr>
                        )}
                        {!loading && exceptions.length === 0 && (
                            <tr>
                                <td colSpan={3} className="px-6 py-10 text-center text-slate-500 font-medium">
                                    Няма добавени изключения.
                                </td>
                            </tr>
                        )}
                        {exceptions.map(ex => (
                            <tr key={ex.exception_date} className="hover:bg-slate-800/40 transition-colors">
                                <td className="px-6 py-4 font-mono font-bold text-white">{ex.exception_date}</td>
                                <td className="px-6 py-4">
                                    <span className={`px-3 py-1 rounded-md text-xs font-bold border tracking-widest ${BADGE_COLORS[ex.schedule_type_override] ?? 'bg-slate-700/30 text-slate-300 border-slate-700'}`}>
                                        {DAY_LABELS[ex.schedule_type_override] ?? ex.schedule_type_override}
                                    </span>
                                </td>
                                <td className="px-6 py-4 text-right">
                                    <button
                                        onClick={() => handleDelete(ex.exception_date)}
                                        className="px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 rounded-lg text-sm font-medium transition-all duration-300 border border-transparent hover:border-rose-500/30"
                                    >
                                        Изтрий
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
