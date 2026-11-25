import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import Modal from './Modal';
import { NARROW, useMediaQuery } from '../useMediaQuery';
import { addDays, formatDateBg, todayInSofia, weekdayBg } from '../format';
import type { GtfsStop, GtfsTrainDetail, GtfsTrainList, GtfsTrainRow } from '../types';

const BUS = 'АВТ';

function CategoryBadges({ categories }: { categories: string[] }) {
    return (
        <>
            {categories.map((c) => (
                <span key={c} className={`badge ${c === BUS ? 'badge-warning' : ''}`}>{c}</span>
            ))}
        </>
    );
}

/** A time with a "+1" marker once the trip has crossed midnight. */
function Time({ value, day }: { value: string; day: number }) {
    return (
        <>
            {value}
            {day > 0 && <sup className="ml-0.5 text-[0.625rem] font-semibold text-link">+{day}</sup>}
        </>
    );
}

// ── Route of one train on the chosen date ────────────────────────────────────

function StopRow({ stop, index, count, legIndex, legCount }: {
    stop: GtfsStop; index: number; count: number; legIndex: number; legCount: number;
}) {
    const isFirst = index === 0;
    const isLast = index === count - 1;

    const lines: { text: string; day: number }[] = [];
    if (isFirst) {
        const t = stop.depart ?? stop.arrive;
        if (t) lines.push({ text: t, day: stop.depart ? stop.departDay : stop.arriveDay });
    } else if (isLast) {
        const t = stop.arrive ?? stop.depart;
        if (t) lines.push({ text: t, day: stop.arrive ? stop.arriveDay : stop.departDay });
    } else {
        if (stop.arrive) lines.push({ text: stop.arrive, day: stop.arriveDay });
        if (stop.depart && stop.depart !== stop.arrive) lines.push({ text: stop.depart, day: stop.departDay });
    }
    if (lines.length === 0) lines.push({ text: '--:--', day: 0 });

    // Where two legs meet (train → replacement bus) the same station closes one
    // leg and opens the next.
    const isTransfer = legCount > 1 && ((isFirst && legIndex > 0) || (isLast && legIndex < legCount - 1));
    const caption = isTransfer ? 'Прекачване' : isFirst ? 'Начална гара' : isLast ? 'Крайна гара' : `Спирка ${index}`;

    return (
        <li
            className="tl-row"
            style={{ '--i': Math.min(index, 14) } as React.CSSProperties}
            data-first={isFirst ? '' : undefined}
            data-last={isLast ? '' : undefined}
            data-edge={isFirst || isLast ? '' : undefined}
        >
            <span className="tl-time">
                {lines.map((l, i) => (
                    <span key={i} className="block"><Time value={l.text} day={l.day} /></span>
                ))}
            </span>
            <span className="tl-rail"><i className="tl-dot" /></span>
            <div className="tl-name">
                {stop.station ? (
                    <p className={isFirst || isLast ? 'font-semibold' : 'font-medium'}>{stop.station}</p>
                ) : (
                    <p
                        className="font-medium italic text-muted"
                        title="Спирката от GTFS няма съответствие в списъка ни с гари"
                    >
                        Неразпозната гара
                    </p>
                )}
                <p className="text-xs text-muted">{caption}</p>
            </div>
        </li>
    );
}

function ScheduleModal({ train, date, onClose }: { train: GtfsTrainRow; date: string; onClose: () => void }) {
    const [detail, setDetail] = useState<GtfsTrainDetail | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/admin/gtfs/trains/${encodeURIComponent(train.trainNumber)}?date=${date}`);
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Маршрутът не се зареди');
                if (!cancelled) setDetail(data);
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : 'Маршрутът не се зареди');
            }
        })();
        return () => { cancelled = true; };
    }, [train.trainNumber, date]);

    return (
        <Modal label={`Влак ${train.trainNumber}`} onClose={onClose} dismissable>
            {(close) => (
                <div className="modal-panel max-w-2xl">
                    <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3 sm:gap-4 sm:px-6 sm:py-4">
                        <div>
                            <h3 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                                <span>Влак {train.trainNumber}</span>
                                <CategoryBadges categories={train.categories} />
                                {!!detail?.operators.length && (
                                    <span className="badge badge-accent">
                                        Оператор: {detail.operators.map((o) => o.name).join(', ')}
                                    </span>
                                )}
                            </h3>
                            <p className="hint mt-1">
                                {weekdayBg(date)}, {formatDateBg(date)} · {train.stops} спирки
                            </p>
                        </div>
                        <button onClick={close} aria-label="Затвори" className="btn btn-ghost btn-icon">
                            <X size={16} strokeWidth={2} aria-hidden="true" />
                        </button>
                    </div>

                    <div className="modal-scroll flex-1 px-4 py-5 sm:p-6">
                        {error ? (
                            <div role="alert" className="alert alert-danger">
                                <CircleAlert size={16} aria-hidden="true" />
                                <span>{error}</span>
                            </div>
                        ) : !detail ? (
                            <p className="py-10 text-center text-muted">Зареждане на маршрута...</p>
                        ) : (
                            <div className="view-enter">
                                {detail.legs.map((leg, li) => (
                                    <section key={leg.tripId} className={li > 0 ? 'mt-7' : ''}>
                                        {detail.legs.length > 1 && (
                                            <div className="mb-3 flex items-center gap-2">
                                                <span className="section-title">Участък {li + 1}</span>
                                                <span className={`badge ${leg.category === BUS ? 'badge-warning' : ''}`}>
                                                    {leg.category === BUS ? 'Заместващ автобус' : leg.category}
                                                </span>
                                            </div>
                                        )}
                                        <ol className="mx-auto max-w-md">
                                            {leg.stops.map((stop, i) => (
                                                <StopRow
                                                    key={stop.seq}
                                                    stop={stop}
                                                    index={i}
                                                    count={leg.stops.length}
                                                    legIndex={li}
                                                    legCount={detail.legs.length}
                                                />
                                            ))}
                                        </ol>
                                    </section>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </Modal>
    );
}

// ── The same trains on a narrow screen ───────────────────────────────────────

/** Seven columns do not fit a phone: one tappable row per train instead. */
function TrainList({ trains, onOpen }: { trains: GtfsTrainRow[]; onOpen: (t: GtfsTrainRow) => void }) {
    const unknown = <em className="text-muted">Неразпозната гара</em>;
    return (
        <ul className="divide-list">
            {trains.map((t) => (
                <li key={t.trainNumber}>
                    <button type="button" className="row-button" onClick={() => onOpen(t)}>
                        <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                                <span className="num font-mono text-base font-semibold">{t.trainNumber}</span>
                                <CategoryBadges categories={t.categories} />
                                <span className="num ml-auto whitespace-nowrap font-mono text-[0.8125rem]">
                                    {t.departs ?? '—'}
                                    <span className="mx-1 text-faint">–</span>
                                    {t.arrives ? <Time value={t.arrives} day={t.arrivesDay} /> : '—'}
                                </span>
                            </span>
                            <span className="mt-1 block text-[0.8125rem] text-muted">
                                {t.from ?? unknown}
                                <span className="mx-1.5 text-faint">→</span>
                                {t.to ?? unknown}
                            </span>
                        </span>
                        <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden="true" />
                    </button>
                </li>
            ))}
            {trains.length === 0 && <li className="py-12 text-center text-muted">Няма намерени влакове.</li>}
        </ul>
    );
}

// ── The screen ───────────────────────────────────────────────────────────────

export default function TrainSchedules() {
    const [date, setDate] = useState('');
    const [list, setList] = useState<GtfsTrainList | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState<GtfsTrainRow | null>(null);
    const requestId = useRef(0);
    const narrow = useMediaQuery(NARROW);

    // `wanted` null = let the server pick (today, or the nearest covered day).
    const load = useCallback(async (wanted: string | null) => {
        const id = ++requestId.current;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(wanted ? `/api/admin/gtfs/trains?date=${wanted}` : '/api/admin/gtfs/trains');
            const data = await res.json();
            if (id !== requestId.current) return; // a newer date was picked meanwhile
            if (!res.ok) throw new Error(data.error || 'Разписанията не се заредиха');
            setList(data);
            setDate(data.date);
        } catch (e) {
            if (id === requestId.current) setError(e instanceof Error ? e.message : 'Разписанията не се заредиха');
        } finally {
            if (id === requestId.current) setLoading(false);
        }
    }, []);

    useEffect(() => { load(null); }, [load]);

    const range = list?.range ?? null;

    const changeDate = (next: string) => {
        if (!next) return; // the picker reports '' while a date is half-typed
        setDate(next);
        load(next);
    };

    const todayTarget = (() => {
        const t = todayInSofia();
        if (!range) return t;
        return t < range.from ? range.from : t > range.to ? range.to : t;
    })();

    const filtered = useMemo(() => {
        const trains = list?.trains ?? [];
        const q = query.trim().toLowerCase();
        if (!q) return trains;
        return trains.filter((t) =>
            t.trainNumber.includes(q)
            || t.categories.some((c) => c.toLowerCase().includes(q))
            || (t.from ?? '').toLowerCase().includes(q)
            || (t.to ?? '').toLowerCase().includes(q));
    }, [list, query]);

    const outsideRange = !!range && !!date && (date < range.from || date > range.to);

    return (
        <div className="view-enter space-y-6">
            <div>
                <h2 className="page-title">Разписания</h2>
                <p className="page-sub">
                    Запазените GTFS разписания — същите, от които приложението показва влаковете.
                    Избери дата, за да видиш кои влакове се движат в този ден.
                </p>
            </div>

            <div className="card card-pad flex flex-wrap items-end justify-between gap-4">
                <div className="w-full sm:w-auto">
                    <label htmlFor="sched-date" className="label">Дата</label>
                    <div className="flex flex-wrap items-center gap-1.5 sm:flex-nowrap">
                        <button
                            type="button"
                            aria-label="Предишен ден"
                            className="btn btn-secondary btn-icon"
                            disabled={!date || !!(range && date <= range.from)}
                            onClick={() => changeDate(addDays(date, -1))}
                        >
                            <ChevronLeft size={16} aria-hidden="true" />
                        </button>
                        <input
                            id="sched-date"
                            type="date"
                            className="input min-w-0 flex-1 sm:w-44 sm:flex-none"
                            value={date}
                            min={range?.from}
                            max={range?.to}
                            onChange={(e) => changeDate(e.target.value)}
                        />
                        <button
                            type="button"
                            aria-label="Следващ ден"
                            className="btn btn-secondary btn-icon"
                            disabled={!date || !!(range && date >= range.to)}
                            onClick={() => changeDate(addDays(date, 1))}
                        >
                            <ChevronRight size={16} aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            className="btn btn-secondary w-full sm:ml-1.5 sm:w-auto"
                            disabled={!date || date === todayTarget}
                            onClick={() => changeDate(todayTarget)}
                        >
                            Днес
                        </button>
                    </div>
                </div>

                <div className="sm:text-right">
                    {date && <p className="font-medium">{weekdayBg(date)}, {formatDateBg(date)}</p>}
                    {range && <p className="hint">Данните покриват {formatDateBg(range.from)} – {formatDateBg(range.to)}</p>}
                </div>
            </div>

            {error && (
                <div role="alert" className="alert alert-danger">
                    <CircleAlert size={16} aria-hidden="true" />
                    <span>{error}</span>
                </div>
            )}

            {!list && loading && <p className="py-6 text-muted">Зареждане на разписанията...</p>}

            {list && !list.hasData && (
                <div className="alert alert-info block">Още няма импортирани GTFS разписания.</div>
            )}

            {list && list.hasData && (
                <>
                    <div className="sticky-search flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                        <div className="relative w-full sm:max-w-sm">
                            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" aria-hidden="true" />
                            <input
                                type="search"
                                enterKeyHint="search"
                                autoCorrect="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                aria-label="Търсене на влак"
                                placeholder="Номер, категория или гара..."
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                className="input pl-9"
                            />
                        </div>
                        <p className="num text-[0.8125rem] text-muted sm:text-sm">
                            {filtered.length === list.trains.length
                                ? `${list.trains.length} влака`
                                : `${filtered.length} от ${list.trains.length} влака`}
                        </p>
                    </div>

                    {list.trains.length === 0 ? (
                        <div className="alert alert-info block">
                            {outsideRange && range
                                ? `За ${formatDateBg(date)} няма разписание — данните покриват ${formatDateBg(range.from)} – ${formatDateBg(range.to)}.`
                                : `В записаните разписания няма влакове за ${formatDateBg(date)}.`}
                        </div>
                    ) : (
                        <div className={`card overflow-hidden transition-opacity duration-150 ${loading ? 'opacity-60' : ''}`}>
                            {narrow ? <TrainList trains={filtered} onOpen={setOpen} /> : (
                                <div className="overflow-x-auto desktop:max-h-[640px] desktop:overflow-auto">
                                    <table className="table">
                                        <thead>
                                            <tr>
                                                <th>Влак №</th>
                                                <th>Категория</th>
                                                <th>Маршрут</th>
                                                <th>Тръгва</th>
                                                <th>Пристига</th>
                                                <th className="hidden md:table-cell">Спирки</th>
                                                <th className="text-right"><span className="sr-only">Действия</span></th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {filtered.map((t) => (
                                                <tr key={t.trainNumber} className="cursor-pointer" onClick={() => setOpen(t)}>
                                                    <td className="num font-mono text-base font-semibold">{t.trainNumber}</td>
                                                    <td>
                                                        <div className="flex flex-wrap gap-1">
                                                            <CategoryBadges categories={t.categories} />
                                                        </div>
                                                    </td>
                                                    <td>
                                                        <span className="font-medium">{t.from ?? <em className="text-muted">Неразпозната гара</em>}</span>
                                                        <span className="mx-1.5 text-faint">→</span>
                                                        <span className="font-medium">{t.to ?? <em className="text-muted">Неразпозната гара</em>}</span>
                                                    </td>
                                                    <td className="num font-mono">{t.departs ?? '—'}</td>
                                                    <td className="num font-mono">
                                                        {t.arrives ? <Time value={t.arrives} day={t.arrivesDay} /> : '—'}
                                                    </td>
                                                    <td className="num hidden text-muted md:table-cell">{t.stops}</td>
                                                    <td className="text-right">
                                                        <button type="button" className="btn btn-secondary btn-sm">Маршрут</button>
                                                    </td>
                                                </tr>
                                            ))}
                                            {filtered.length === 0 && (
                                                <tr>
                                                    <td colSpan={7} className="!py-12 text-center text-muted">Няма намерени влакове.</td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}

            {open && date && <ScheduleModal train={open} date={date} onClose={() => setOpen(null)} />}
        </div>
    );
}
