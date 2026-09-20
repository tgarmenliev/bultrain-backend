import { useState, useEffect, useMemo } from 'react';
import { Plus, Search, X } from 'lucide-react';
import Modal from './Modal';

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
    valid_from: string | null;
    valid_to: string | null;
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
    const [importValidFrom, setImportValidFrom] = useState('');
    const [importValidTo, setImportValidTo] = useState('');
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
        setImportValidFrom('');
        setImportValidTo('');
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
                    days: importDays,
                    ...(importValidFrom && importValidTo && {
                        valid_from: importValidFrom,
                        valid_to: importValidTo,
                    }),
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
        return <div className="py-8 text-muted">Зареждане на влаковете...</div>;
    }

    if (error) {
        return <div role="alert" className="alert alert-danger">Грешка: {error}</div>;
    }

    const closeIcon = <X size={16} strokeWidth={2} aria-hidden="true" />;

    return (
        <div className="view-enter space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="page-title">Управление на влакове</h2>
                    <p className="page-sub">Преглед, изтриване и редакция на разписания.</p>
                </div>
                <button onClick={() => setIsCreateModalOpen(true)} className="btn btn-primary shrink-0">
                    <Plus size={16} strokeWidth={2.25} aria-hidden="true" />
                    Добави нов влак
                </button>
            </div>

            {/* Search */}
            <div className="relative max-w-sm">
                <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" aria-hidden="true" />
                <input
                    type="text"
                    aria-label="Търсене на влак"
                    placeholder="Търсене по номер или категория..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="input pl-9"
                />
            </div>

            {/* Trains table */}
            <div className="card overflow-hidden">
                <div className="max-h-[600px] overflow-y-auto">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Влак №</th>
                                <th>Категория</th>
                                <th className="text-right">Действия</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredTrains.map((train) => (
                                <tr key={train.train_number}>
                                    <td className="num font-mono text-base font-semibold">{train.train_number}</td>
                                    <td><span className="badge">{train.category}</span></td>
                                    <td className="text-right">
                                        <div className="flex justify-end gap-2">
                                            <button onClick={() => handleOpenModal(train)} className="btn btn-secondary btn-sm">
                                                Разписание / Редакция
                                            </button>
                                            <button onClick={() => handleDeleteTrain(train.train_number)} className="btn btn-danger btn-sm">
                                                Изтрий
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {filteredTrains.length === 0 && (
                                <tr>
                                    <td colSpan={3} className="!py-12 text-center text-muted">Няма намерени влакове.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Train schedule modal */}
            {modalTrain && (
                <Modal label={`Влак ${modalTrain.train_number}`} onClose={handleCloseModal}>
                    {(close) => (
                    <div className="modal-panel max-w-3xl">

                        <div className="flex items-center justify-between border-b border-line px-6 py-4">
                            <h3 className="flex items-center gap-3 text-lg font-semibold">
                                <span className="badge">{modalTrain.category}</span>
                                <span>Влак {modalTrain.train_number}</span>
                            </h3>
                            <button onClick={close} aria-label="Затвори" className="btn btn-ghost btn-icon">
                                {closeIcon}
                            </button>
                        </div>

                        <div role="tablist" className="flex gap-6 border-b border-line px-6">
                            <button role="tab" aria-selected={activeTab === 'timeline'} onClick={() => setActiveTab('timeline')} className="tab">
                                Маршрут
                            </button>
                            <button role="tab" aria-selected={activeTab === 'json'} onClick={() => setActiveTab('json')} className="tab">
                                Обнови чрез JSON
                            </button>
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto p-6">

                            {/* TIMELINE TAB */}
                            {activeTab === 'timeline' && (
                                <div className="view-enter space-y-6">
                                    {scheduleLoading ? (
                                        <div className="py-10 text-center text-muted">Зареждане на маршрута...</div>
                                    ) : validities.length === 0 ? (
                                        <div className="py-10 text-center text-muted">Няма намерено разписание за този влак.</div>
                                    ) : (
                                        <>
                                            {/* Validity selector */}
                                            <div className="space-y-3 border-b border-line pb-5">
                                                <div className="flex flex-wrap gap-2">
                                                    {validities.map((v, i) => (
                                                        <button
                                                            key={v.validity_id}
                                                            onClick={() => setSelectedValidityIndex(i)}
                                                            aria-pressed={selectedValidityIndex === i}
                                                            className={`btn btn-secondary h-auto py-2 ${selectedValidityIndex === i ? 'border-accent bg-accent-soft text-link' : ''}`}
                                                        >
                                                            {`Вариант ${i + 1}`}
                                                            <span className="border-l border-current pl-2 text-xs opacity-80">
                                                                {getDaysLabel(v.days)}
                                                            </span>
                                                            {v.valid_from && v.valid_to && (
                                                                <span className="font-mono text-[0.6875rem] opacity-70">
                                                                    {v.valid_from} → {v.valid_to}
                                                                </span>
                                                            )}
                                                        </button>
                                                    ))}
                                                </div>

                                                {validities[selectedValidityIndex] && (
                                                    <div className="flex justify-end">
                                                        <button
                                                            onClick={() => handleDeleteValidity(validities[selectedValidityIndex].validity_id)}
                                                            className="btn btn-danger btn-sm"
                                                        >
                                                            Изтрий този вариант
                                                        </button>
                                                    </div>
                                                )}
                                            </div>

                                            {/* Selected timeline */}
                                            {validities[selectedValidityIndex] && (
                                                <ol key={selectedValidityIndex} className="mx-auto max-w-md pt-1">
                                                    {validities[selectedValidityIndex]?.schedule?.map((stop, index) => {
                                                        const isFirst = index === 0;
                                                        const isLast = index === validities[selectedValidityIndex].schedule.length - 1;
                                                        const tArr = stop.arrival_time;
                                                        const tDep = stop.departure_time;

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
                                                            <li
                                                                key={index}
                                                                className="tl-row"
                                                                style={{ '--i': Math.min(index, 14) } as React.CSSProperties}
                                                                data-first={isFirst ? '' : undefined}
                                                                data-last={isLast ? '' : undefined}
                                                                data-edge={isFirst || isLast ? '' : undefined}
                                                            >
                                                                <span className="tl-time">{displayTime}</span>
                                                                <span className="tl-rail"><i className="tl-dot" /></span>
                                                                <div className="tl-name">
                                                                    <p className={isFirst || isLast ? 'font-semibold' : 'font-medium'}>
                                                                        {stop.station_name}
                                                                    </p>
                                                                    <p className="text-xs text-muted">
                                                                        {isFirst ? 'Начална гара' : isLast ? 'Крайна гара' : `Спирка ${index}`}
                                                                    </p>
                                                                </div>
                                                            </li>
                                                        );
                                                    })}
                                                </ol>
                                            )}
                                        </>
                                    )}
                                </div>
                            )}

                            {/* JSON IMPORT TAB */}
                            {activeTab === 'json' && (
                                <div className="view-enter flex h-full flex-col gap-5">
                                    <div className="space-y-5 rounded-lg border border-line bg-canvas p-4">
                                        <div>
                                            <h4 className="section-title mb-3">Дни на движение</h4>
                                            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                                                {DAYS_MAP.map((day) => (
                                                    <label key={day.key} className="flex cursor-pointer items-center gap-2 text-sm">
                                                        <input
                                                            type="checkbox"
                                                            checked={importDays[day.key as keyof typeof importDays]}
                                                            onChange={(e) => setImportDays({ ...importDays, [day.key]: e.target.checked })}
                                                            className="h-4 w-4 cursor-pointer"
                                                        />
                                                        {day.label}
                                                    </label>
                                                ))}
                                            </div>
                                        </div>

                                        <div className="border-t border-line pt-4">
                                            <h4 className="section-title">Временен период <span className="font-normal text-muted">(незадължително)</span></h4>
                                            <p className="hint mb-3 mt-0.5">Остави празно за постоянно (общо) разписание.</p>
                                            <div className="flex flex-wrap gap-4">
                                                <div className="min-w-[140px] flex-1">
                                                    <label htmlFor="imp-from" className="label">Валидно от</label>
                                                    <input id="imp-from" type="date" value={importValidFrom} onChange={e => setImportValidFrom(e.target.value)} className="input" />
                                                </div>
                                                <div className="min-w-[140px] flex-1">
                                                    <label htmlFor="imp-to" className="label">Валидно до</label>
                                                    <input id="imp-to" type="date" value={importValidTo} onChange={e => setImportValidTo(e.target.value)} className="input" />
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="alert alert-info block">
                                        <p>Поставете JSON масив с гарите тук. Това ще създаде <strong>нов вариант</strong> на разписание за избраните дни.</p>
                                        <p className="mt-1.5 text-xs text-muted">
                                            За да замените напълно старо разписание, изтрийте старите варианти от таб "Маршрут".
                                        </p>
                                    </div>

                                    <textarea
                                        value={jsonInput}
                                        onChange={(e) => setJsonInput(e.target.value)}
                                        placeholder="Вмъкнете JSON масив тук..."
                                        aria-label="JSON с разписанието"
                                        className="input min-h-[250px] flex-1 font-mono text-[0.8125rem]"
                                    />

                                    {importStatus && (
                                        <div role="alert" className={`alert ${importStatus.type === 'success' ? 'alert-success' : 'alert-danger'}`}>
                                            {importStatus.msg}
                                        </div>
                                    )}

                                    <div className="flex justify-end">
                                        <button onClick={handleImportJson} disabled={!jsonInput.trim()} className="btn btn-primary">
                                            Създай график
                                        </button>
                                    </div>
                                </div>
                            )}

                        </div>
                    </div>
                    )}
                </Modal>
            )}

            {/* Create train modal */}
            {isCreateModalOpen && (
                <Modal label="Добави нов влак" onClose={() => setIsCreateModalOpen(false)}>
                    {(close) => (
                    <div className="modal-panel max-w-lg">
                        <div className="flex items-center justify-between border-b border-line px-6 py-4">
                            <h3 className="text-lg font-semibold">Добави нов влак</h3>
                            <button onClick={close} aria-label="Затвори" className="btn btn-ghost btn-icon">
                                {closeIcon}
                            </button>
                        </div>

                        <form onSubmit={handleCreateTrain} className="space-y-5 p-6">
                            {createError && (
                                <div role="alert" className="alert alert-danger">{createError}</div>
                            )}

                            <div>
                                <label htmlFor="new-train-no" className="label">Номер на влак</label>
                                <input
                                    id="new-train-no"
                                    type="text"
                                    required
                                    value={newTrainData.train_number}
                                    onChange={(e) => setNewTrainData({ ...newTrainData, train_number: e.target.value })}
                                    placeholder="Напр. 1611"
                                    className="input font-mono"
                                />
                            </div>

                            <div>
                                <label htmlFor="new-train-cat" className="label">Категория</label>
                                <select
                                    id="new-train-cat"
                                    value={newTrainData.category}
                                    onChange={(e) => setNewTrainData({ ...newTrainData, category: e.target.value })}
                                    className="input"
                                >
                                    <option value="ПВ">ПВ (Пътнически влак)</option>
                                    <option value="БВ">БВ (Бърз влак)</option>
                                    <option value="БВЗР">БВЗР (Бърз влак със задължителна резервация)</option>
                                    <option value="МБВ">МБВ (Международен бърз влак)</option>
                                    <option value="КПВ">КПВ (Крайградски пътнически влак)</option>
                                </select>
                            </div>

                            <div className="flex justify-end gap-2 border-t border-line pt-5">
                                <button type="button" onClick={close} className="btn btn-ghost">
                                    Отказ
                                </button>
                                <button type="submit" disabled={createLoading} className="btn btn-primary">
                                    {createLoading ? 'Създаване...' : 'Създай влак'}
                                </button>
                            </div>
                        </form>
                    </div>
                    )}
                </Modal>
            )}
        </div>
    );
}
