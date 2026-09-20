import { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';

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

// Weekdays stay neutral; only the two non-working schedule types get a colour.
const BADGE_COLORS: Record<string, string> = {
    saturday: 'badge-accent',
    sunday:   'badge-warning',
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
        <div className="view-enter space-y-8">
            <div>
                <h2 className="page-title">Празници и изключения</h2>
                <p className="page-sub">
                    Задайте конкретна дата да използва различен тип разписание (напр. национален празник → неделно разписание).
                </p>
            </div>

            {/* Add form */}
            <div className="card card-pad">
                <h3 className="section-title mb-4">Добави изключение</h3>
                <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-4">
                    <div className="min-w-[160px] flex-1">
                        <label htmlFor="ex-date" className="label">Дата</label>
                        <input
                            id="ex-date"
                            type="date"
                            required
                            value={formDate}
                            onChange={e => setFormDate(e.target.value)}
                            className="input"
                        />
                    </div>
                    <div className="min-w-[200px] flex-1">
                        <label htmlFor="ex-type" className="label">Тип разписание</label>
                        <select
                            id="ex-type"
                            value={formOverride}
                            onChange={e => setFormOverride(e.target.value)}
                            className="input"
                        >
                            {DAY_OPTIONS.map(o => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                        </select>
                    </div>
                    <button type="submit" disabled={submitting} className="btn btn-primary shrink-0">
                        {!submitting && <Plus size={16} strokeWidth={2.25} aria-hidden="true" />}
                        {submitting ? 'Запазване...' : 'Добави'}
                    </button>
                </form>
                {formError && (
                    <p role="alert" className="mt-3 text-sm text-danger">{formError}</p>
                )}
            </div>

            {/* Exceptions table */}
            <div className="card overflow-hidden">
                <table className="table">
                    <thead>
                        <tr>
                            <th>Дата</th>
                            <th>Тип разписание</th>
                            <th className="text-right">Действия</th>
                        </tr>
                    </thead>
                    <tbody>
                        {loading && (
                            <tr>
                                <td colSpan={3} className="!py-10 text-center text-muted">Зареждане...</td>
                            </tr>
                        )}
                        {!loading && exceptions.length === 0 && (
                            <tr>
                                <td colSpan={3} className="!py-10 text-center text-muted">Няма добавени изключения.</td>
                            </tr>
                        )}
                        {exceptions.map(ex => (
                            <tr key={ex.exception_date}>
                                <td className="num font-mono font-medium">{ex.exception_date}</td>
                                <td>
                                    <span className={`badge ${BADGE_COLORS[ex.schedule_type_override] ?? ''}`}>
                                        {DAY_LABELS[ex.schedule_type_override] ?? ex.schedule_type_override}
                                    </span>
                                </td>
                                <td className="text-right">
                                    <button onClick={() => handleDelete(ex.exception_date)} className="btn btn-danger btn-sm">
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
