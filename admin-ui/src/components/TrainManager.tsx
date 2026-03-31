import { useState, useEffect, useMemo } from 'react';

export interface Train {
    train_number: string;
    category: string;
}

export interface Stop {
    station_name: string;
    arrival_time: string | null;
    departure_time: string | null;
    stop_sequence: number;
}

export interface Validity {
    validity_id: number;
    description: string;
    days: {
        monday: number; tuesday: number; wednesday: number; thursday: number; friday: number; saturday: number; sunday: number;
    };
    schedule: Stop[];
}

const DAYS_MAP = [
    { key: 'monday', label: 'Понеделник', short: 'Пн' },
    { key: 'tuesday', label: 'Вторник', short: 'Вт' },
    { key: 'wednesday', label: 'Сряда', short: 'Ср' },
    { key: 'thursday', label: 'Четвъртък', short: 'Чт' },
    { key: 'friday', label: 'Петък', short: 'Пт' },
    { key: 'saturday', label: 'Събота', short: 'Сб' },
    { key: 'sunday', label: 'Неделя', short: 'Нд' },
] as const;

export default function TrainManager() {
    const [trains, setTrains] = useState<Train[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');

    // Modal State
    const [modalTrain, setModalTrain] = useState<Train | null>(null);
    const [activeTab, setActiveTab] = useState<'timeline' | 'json'>('timeline');
    const [validities, setValidities] = useState<Validity[]>([]);
    const [selectedValidityIndex, setSelectedValidityIndex] = useState<number>(0);
    const [scheduleLoading, setScheduleLoading] = useState(false);

    // Create Modal State
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const [newTrainData, setNewTrainData] = useState({ train_number: '', category: 'БВ' });
    const [createLoading, setCreateLoading] = useState(false);
    const [createError, setCreateError] = useState('');

    // JSON Import State
    const [jsonInput, setJsonInput] = useState('');
    const [importDays, setImportDays] = useState({
        monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true
    });
    const [importStatus, setImportStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

    const getDaysLabel = (days: Validity['days']) => {
        const d = [days.monday, days.tuesday, days.wednesday, days.thursday, days.friday, days.saturday, days.sunday];
        if (d.every(v => v)) return "Всеки ден";
        if (d.slice(0, 5).every(v => v) && !d[5] && !d[6]) return "Делник (Пон-Пет)";
        if (!d.slice(0, 5).some(v => v) && d[5] && d[6]) return "Уикенд (Съб-Нед)";
        return d.map((v, i) => v ? DAYS_MAP[i].short : null).filter(Boolean).join(', ');
    };

    const fetchTrains = async () => {
        try {
            setLoading(true);
            const res = await fetch('/api/admin/trains');
            if (!res.ok) throw new Error('Неуспешно зареждане на влаковете');
            const data = await res.json();
            setTrains(data);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchTrains();
    }, []);

    const filteredTrains = useMemo(() => {
        if (!searchQuery) return trains;
        return trains.filter(t => t.train_number.includes(searchQuery) || t.category.toLowerCase().includes(searchQuery.toLowerCase()));
    }, [trains, searchQuery]);

    const handleDeleteTrain = async (trainNo: string) => {
        if (!window.confirm(`Сигурни ли сте, че искате да изтриете влак ${trainNo} и цялото му разписание? Това действие е необратимо.`)) return;
        try {
            const res = await fetch(`/api/admin/trains/${trainNo}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Грешка при изтриване');
            setTrains(prev => prev.filter(t => t.train_number !== trainNo));
        } catch (err: any) {
            alert(err.message);
        }
    };

    const handleOpenModal = async (train: Train) => {
        setModalTrain(train);
        setActiveTab('timeline');
        setImportStatus(null);
        setJsonInput('');
        setImportDays({ monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true });
        setSelectedValidityIndex(0);
        await fetchSchedule(train.train_number);
    };

    const fetchSchedule = async (trainNo: string) => {
        try {
            setScheduleLoading(true);
            const res = await fetch(`/api/admin/trains/${trainNo}/schedule`);
            if (!res.ok) throw new Error('Грешка при зареждане на разписанието');
            const data: Validity[] = await res.json();
            setValidities(data);
        } catch (err: any) {
            console.error(err);
        } finally {
            setScheduleLoading(false);
        }
    };

    const handleCloseModal = () => {
        setModalTrain(null);
        setValidities([]);
        setSelectedValidityIndex(0);
    };

    const handleDeleteValidity = async (validityId: number) => {
        if (!window.confirm('Сигурни ли сте, че искате да изтриете този вариант на разписанието?')) return;
        try {
            setScheduleLoading(true);
            const res = await fetch(`/api/admin/validity/${validityId}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Грешка при изтриване на графика.');
            await fetchSchedule(modalTrain!.train_number);
            setSelectedValidityIndex(0);
        } catch (err: any) {
            alert(err.message);
        } finally {
            setScheduleLoading(false);
        }
    };

    const handleCreateTrain = async (e: React.FormEvent) => {
        e.preventDefault();
        setCreateError('');
        setCreateLoading(true);
        try {
            const res = await fetch('/api/admin/trains', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newTrainData)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Грешка при създаване');
            await fetchTrains();

            setIsCreateModalOpen(false);
            const createdTrain = { train_number: newTrainData.train_number, category: newTrainData.category };
            setNewTrainData({ train_number: '', category: 'БВ' });

            // Open the schedule modal immediately for convenience
            handleOpenModal(createdTrain);
        } catch (err: any) {
            setCreateError(err.message);
        } finally {
            setCreateLoading(false);
        }
    };

    const handleImportJson = async () => {
        setImportStatus(null);
        if (!modalTrain) return;

        let parsedData;
        try {
            parsedData = JSON.parse(jsonInput);
            if (!parsedData.stations || !Array.isArray(parsedData.stations)) {
                throw new Error('JSON обектът трябва да съдържа масив "stations".');
            }
        } catch (e: any) {
            setImportStatus({ type: 'error', msg: `Невалиден JSON: ${e.message}` });
            return;
        }

        try {
            const res = await fetch(`/api/admin/trains/${modalTrain.train_number}/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    schedule: parsedData.stations || parsedData,
                    days: importDays
                }),
            });

            const result = await res.json();
            if (!res.ok) throw new Error(result.error || 'Грешка при импортиране');

            setImportStatus({ type: 'success', msg: result.message });
            setJsonInput('');
            // Refresh the timeline data silently so it's ready if they switch tabs
            await fetchSchedule(modalTrain.train_number);
        } catch (err: any) {
            setImportStatus({ type: 'error', msg: err.message });
        }
    };

    if (loading && trains.length === 0) {
        return <div className="p-8 text-neutral-400">Зареждане на влаковете...</div>;
    }

    if (error) {
        return <div className="p-8 text-red-500">Грешка: {error}</div>;
    }

    return (
        <div className="space-y-8 animate-in-fade relative z-10" style={{ animationDelay: '0.2s' }}>
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-3xl font-bold text-gradient">Управление на Влакове</h2>
                    <p className="text-slate-400 text-sm mt-2">Преглед, изтриване и редакция на разписания.</p>
                </div>
                <button
                    onClick={() => setIsCreateModalOpen(true)}
                    className="btn-glow"
                >
                    Добави нов влак
                </button>
            </div>

            {/* Search Bar */}
            <div className="relative group">
                <input
                    type="text"
                    placeholder="Търсене по номер или категория..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="input-premium w-full max-w-md pr-10 shadow-lg"
                />
                <div className="absolute inset-y-0 right-0 max-w-sm pr-3 flex items-center pointer-events-none">
                    <svg className="h-5 w-5 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                </div>
            </div>

            {/* Trains Table */}
            <div className="glass-card rounded-2xl overflow-hidden shadow-2xl max-h-[600px] overflow-y-auto">
                <table className="w-full text-left text-sm text-slate-300">
                    <thead className="bg-slate-950/80 backdrop-blur-md text-slate-400 border-b border-slate-800 uppercase text-xs tracking-wider sticky top-0 z-10">
                        <tr>
                            <th className="px-6 py-4 font-medium">Влак №</th>
                            <th className="px-6 py-4 font-medium">Категория</th>
                            <th className="px-6 py-4 font-medium text-right">Действия</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-800/50">
                        {filteredTrains.map((train) => (
                            <tr key={train.train_number} className="hover:bg-slate-800/40 transition-colors">
                                <td className="px-6 py-4 font-black text-white font-mono text-base">{train.train_number}</td>
                                <td className="px-6 py-4">
                                    <span className="px-3 py-1 bg-indigo-500/10 text-indigo-300 rounded-md text-xs font-bold border border-indigo-500/20 shadow-sm shadow-indigo-500/10 tracking-widest">
                                        {train.category}
                                    </span>
                                </td>
                                <td className="px-6 py-4 text-right">
                                    <div className="flex justify-end space-x-3">
                                        <button
                                            onClick={() => handleOpenModal(train)}
                                            className="px-4 py-2 bg-slate-800/50 hover:bg-indigo-500/20 text-slate-300 hover:text-indigo-400 rounded-lg text-sm font-medium transition-all duration-300 border border-transparent hover:border-indigo-500/30"
                                        >
                                            Разписание / Редакция
                                        </button>
                                        <button
                                            onClick={() => handleDeleteTrain(train.train_number)}
                                            className="px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 rounded-lg text-sm font-medium transition-all duration-300 border border-transparent hover:border-rose-500/30"
                                        >
                                            Изтрий
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                        {filteredTrains.length === 0 && (
                            <tr>
                                <td colSpan={3} className="px-6 py-12 text-center text-slate-500 font-medium">
                                    Няма намерени влакове.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* Train Schedule Modal */}
            {modalTrain && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm animate-in-fade">
                    <div className="glass-card w-full max-w-3xl max-h-[90vh] flex flex-col rounded-3xl overflow-hidden ring-1 ring-white/10 shadow-[0_0_50px_rgba(0,0,0,0.5)]">

                        {/* Modal Header */}
                        <div className="px-6 py-5 border-b border-slate-800/50 flex justify-between items-center bg-slate-900/50">
                            <div>
                                <h3 className="text-2xl font-black text-white flex items-center space-x-3">
                                    <span className="bg-indigo-500/20 text-indigo-400 px-3 py-1 rounded-lg text-sm tracking-widest border border-indigo-500/30 shadow-inner">
                                        {modalTrain.category}
                                    </span>
                                    <span>Влак {modalTrain.train_number}</span>
                                </h3>
                            </div>
                            <button onClick={handleCloseModal} className="text-slate-500 hover:text-white transition-colors bg-slate-800/50 hover:bg-slate-700/50 p-2 rounded-full">
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>

                        {/* Modal Tabs */}
                        <div className="flex border-b border-slate-800/50 px-8 pt-4 space-x-8 bg-slate-900/30">
                            <button
                                onClick={() => setActiveTab('timeline')}
                                className={`pb-4 text-sm font-bold uppercase tracking-wider transition-colors relative ${activeTab === 'timeline' ? 'text-indigo-400' : 'text-slate-500 hover:text-slate-300'
                                    }`}
                            >
                                Маршрут
                                {activeTab === 'timeline' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-indigo-500 to-cyan-500 rounded-t-full shadow-[0_-2px_10px_rgba(99,102,241,0.5)]" />}
                            </button>
                            <button
                                onClick={() => setActiveTab('json')}
                                className={`pb-4 text-sm font-bold uppercase tracking-wider transition-colors relative ${activeTab === 'json' ? 'text-indigo-400' : 'text-slate-500 hover:text-slate-300'
                                    }`}
                            >
                                Обнови чрез JSON
                                {activeTab === 'json' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-indigo-500 to-cyan-500 rounded-t-full shadow-[0_-2px_10px_rgba(99,102,241,0.5)]" />}
                            </button>
                        </div>

                        {/* Modal Content Area */}
                        <div className="p-6 overflow-y-auto flex-1 min-h-0">

                            {/* TIMELINE TAB */}
                            {activeTab === 'timeline' && (
                                <div className="space-y-6">
                                    {scheduleLoading ? (
                                        <div className="text-neutral-400 text-center py-10">Зареждане на маршрута...</div>
                                    ) : validities.length === 0 ? (
                                        <div className="text-neutral-500 text-center py-10">Няма намерено разписание за този влак.</div>
                                    ) : (
                                        <>
                                            {/* Validity Selector */}
                                            {validities.length > 0 && (
                                                <div className="flex flex-col gap-4 pb-4 border-b border-neutral-800">
                                                    <div className="flex flex-wrap gap-2">
                                                        {validities.map((v, i) => (
                                                            <button
                                                                key={v.validity_id}
                                                                onClick={() => setSelectedValidityIndex(i)}
                                                                className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all duration-300 border ${selectedValidityIndex === i
                                                                    ? 'bg-gradient-to-r from-indigo-500 to-cyan-500 border-white/20 text-white shadow-[0_0_20px_rgba(99,102,241,0.4)]'
                                                                    : 'bg-slate-900/50 border-slate-700/50 text-slate-400 hover:bg-slate-800 hover:text-white hover:border-slate-600 shadow-inner'
                                                                    }`}
                                                            >
                                                                {`Вариант ${i + 1}`}
                                                                <span className="ml-2 opacity-70 border-l border-current pl-2 text-xs">
                                                                    {getDaysLabel(v.days)}
                                                                </span>
                                                            </button>
                                                        ))}
                                                    </div>

                                                    {/* Active Validity Actions */}
                                                    {validities[selectedValidityIndex] && (
                                                        <div className="flex justify-end">
                                                            <button
                                                                onClick={() => handleDeleteValidity(validities[selectedValidityIndex].validity_id)}
                                                                className="text-xs font-medium text-red-400 hover:text-white bg-red-950/30 hover:bg-red-900/50 px-3 py-1.5 rounded-lg border border-red-900/30 transition-colors"
                                                            >
                                                                Изтрий този вариант
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            )}

                                            {/* Display Selected Timeline */}
                                            {validities[selectedValidityIndex] && (
                                                <div className="relative pl-6 py-4 mx-auto max-w-lg">
                                                    {/* The continuous vertical line */}
                                                    <div className="absolute top-10 bottom-10 left-[62px] w-[2px] bg-gradient-to-b from-indigo-500 via-slate-800 to-indigo-500 rounded-full opacity-50" />

                                                    <div className="space-y-0">
                                                        {validities[selectedValidityIndex]?.schedule?.map((stop, index) => {
                                                            const isFirst = index === 0;
                                                            const isLast = index === validities[selectedValidityIndex].schedule.length - 1;
                                                            const tArr = stop.arrival_time;
                                                            const tDep = stop.departure_time;

                                                            // Cleaner Time Logic
                                                            let displayTime = '';
                                                            if (isFirst) displayTime = tDep || tArr || '--:--';
                                                            else if (isLast) displayTime = tArr || tDep || '--:--';
                                                            else {
                                                                if (tArr && tDep && tArr !== tDep) {
                                                                    displayTime = `${tArr}\n${tDep}`;
                                                                } else {
                                                                    displayTime = tArr || tDep || '--:--';
                                                                }
                                                            }

                                                            return (
                                                                <div key={index} className="relative flex items-center group py-4">
                                                                    {/* Absolute times on the left */}
                                                                    <div className="w-16 flex-shrink-0 text-right pr-4 z-10 py-1 bg-slate-950 shadow-[10px_0_15px_-5px_var(--tw-shadow-color)] shadow-slate-950">
                                                                        <pre className={`text-sm font-mono font-bold leading-tight ${isFirst || isLast ? 'text-indigo-400' : 'text-slate-300 group-hover:text-white transition-colors'}`}>
                                                                            {displayTime}
                                                                        </pre>
                                                                    </div>

                                                                    {/* Node Dot Overlay on the line */}
                                                                    <div className={`z-10 bg-slate-950 border-[3px] rounded-full absolute transition-all duration-500 ${isFirst || isLast
                                                                        ? 'w-[16px] h-[16px] left-[55px] border-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.6)]'
                                                                        : 'w-[12px] h-[12px] left-[57px] border-slate-600 group-hover:border-cyan-400 group-hover:bg-cyan-500 group-hover:shadow-[0_0_15px_rgba(34,211,238,0.6)] group-hover:scale-125'
                                                                        }`} />

                                                                    {/* Station Name */}
                                                                    <div className="pl-12 flex-1 pt-0.5">
                                                                        <p className={`text-base tracking-wide transition-colors duration-300 ${isFirst || isLast ? 'font-black text-white text-lg drop-shadow-md' : 'font-bold text-slate-300 group-hover:text-cyan-300'}`}>
                                                                            {stop.station_name}
                                                                        </p>
                                                                        <p className={`text-[10px] mt-1 uppercase tracking-widest font-black ${isFirst || isLast ? 'text-indigo-400/80' : 'text-slate-600 group-hover:text-slate-400 transition-colors'}`}>
                                                                            {isFirst ? 'Начална гара' : isLast ? 'Крайна гара' : `Спирка ${index}`}
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>
                            )}

                            {/* JSON IMPORT TAB */}
                            {activeTab === 'json' && (
                                <div className="space-y-6 flex flex-col h-full">
                                    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
                                        <h4 className="text-sm font-bold text-white mb-4">Дни на движение</h4>
                                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                            {DAYS_MAP.map((day) => (
                                                <label key={day.key} className="flex items-center space-x-3 cursor-pointer group">
                                                    <div className="relative flex items-center justify-center">
                                                        <input
                                                            type="checkbox"
                                                            checked={importDays[day.key as keyof typeof importDays]}
                                                            onChange={(e) => setImportDays({ ...importDays, [day.key]: e.target.checked })}
                                                            className="peer appearance-none w-5 h-5 border border-neutral-600 rounded bg-neutral-950 checked:bg-blue-600 checked:border-blue-500 transition-colors cursor-pointer"
                                                        />
                                                        <svg className="absolute w-3 h-3 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                                                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                                        </svg>
                                                    </div>
                                                    <span className="text-sm font-medium text-neutral-300 group-hover:text-white transition-colors">
                                                        {day.label}
                                                    </span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 text-sm text-neutral-400">
                                        <p>Поставете JSON масив с гарите тук. Това ще създаде <strong>нов вариант</strong> на разписание за избраните дни.</p>
                                        <p className="mt-2 text-xs opacity-70">
                                            За да замените напълно старо разписание, изтрийте старите варианти от таб "Маршрут".
                                        </p>
                                    </div>

                                    <textarea
                                        value={jsonInput}
                                        onChange={(e) => setJsonInput(e.target.value)}
                                        placeholder="Вмъкнете JSON масив тук..."
                                        className="flex-1 w-full min-h-[250px] bg-neutral-950 border border-neutral-800 rounded-xl p-4 text-green-400 font-mono text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors resize-y shadow-inner block"
                                    />

                                    {importStatus && (
                                        <div className={`p-4 rounded-xl text-sm font-medium border ${importStatus.type === 'success'
                                            ? 'bg-green-950/30 text-green-400 border-green-900/50'
                                            : 'bg-red-950/30 text-red-400 border-red-900/50'
                                            }`}>
                                            {importStatus.msg}
                                        </div>
                                    )}

                                    <div className="flex justify-end pt-2">
                                        <button
                                            onClick={handleImportJson}
                                            disabled={!jsonInput.trim()}
                                            className="px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl font-bold tracking-wide transition-all shadow-lg hover:shadow-blue-900/50"
                                        >
                                            Създай График
                                        </button>
                                    </div>
                                </div>
                            )}

                        </div>
                    </div>
                </div>
            )}

            {/* Create Train Modal */}
            {isCreateModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm animate-in-fade">
                    <div className="glass-card w-full max-w-lg shadow-[0_0_50px_rgba(0,0,0,0.5)] rounded-3xl overflow-hidden ring-1 ring-white/10">
                        <div className="px-8 py-6 border-b border-slate-800/50 flex justify-between items-center bg-slate-900/50">
                            <h3 className="text-2xl font-black text-white">Добави нов влак</h3>
                            <button onClick={() => setIsCreateModalOpen(false)} className="text-slate-500 hover:text-white transition-colors bg-slate-800/50 hover:bg-slate-700/50 p-2 rounded-full">
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>

                        <form onSubmit={handleCreateTrain} className="p-8 space-y-6">
                            {createError && (
                                <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl">
                                    <p className="text-sm font-bold text-rose-400">{createError}</p>
                                </div>
                            )}

                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Номер на влак</label>
                                    <input
                                        type="text"
                                        required
                                        value={newTrainData.train_number}
                                        onChange={(e) => setNewTrainData({ ...newTrainData, train_number: e.target.value })}
                                        placeholder="Напр. 1611"
                                        className="input-premium w-full !py-3 !px-4 text-lg font-mono"
                                    />
                                </div>

                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Категория</label>
                                    <select
                                        value={newTrainData.category}
                                        onChange={(e) => setNewTrainData({ ...newTrainData, category: e.target.value })}
                                        className="input-premium w-full !py-3 !px-4 text-base font-bold text-indigo-300"
                                    >
                                        <option value="ПВ">ПВ (Пътнически влак)</option>
                                        <option value="БВ">БВ (Бърз влак)</option>
                                        <option value="БВЗР">БВЗР (Бърз влак със задължителна резервация)</option>
                                        <option value="МБВ">МБВ (Международен бърз влак)</option>
                                        <option value="КПВ">КПВ (Крайградски пътнически влак)</option>
                                    </select>
                                </div>
                            </div>

                            <div className="pt-6 border-t border-slate-800/50 flex justify-end space-x-4">
                                <button
                                    type="button"
                                    onClick={() => setIsCreateModalOpen(false)}
                                    className="px-6 py-2.5 hover:bg-slate-800 text-slate-300 rounded-xl font-bold transition-all duration-300 border border-transparent hover:border-slate-700"
                                >
                                    Отказ
                                </button>
                                <button
                                    type="submit"
                                    disabled={createLoading}
                                    className="btn-glow px-8 group disabled:opacity-50"
                                >
                                    {createLoading ? 'Създаване...' : 'Създай влак'}
                                    {!createLoading && (
                                        <svg className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                                        </svg>
                                    )}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
