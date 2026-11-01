import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, CircleAlert, Info } from 'lucide-react';
import type { DistanceResult, DistanceStation } from '../types';

const MAX_SUGGESTIONS = 8;

const fmtKm = (km: number) => km.toLocaleString('bg-BG', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Name matches that START with the query come before ones that merely contain it. */
function suggest(stations: DistanceStation[], query: string): DistanceStation[] {
    const q = query.trim().toLowerCase();
    if (!q) return stations.slice(0, MAX_SUGGESTIONS);
    const starts: DistanceStation[] = [];
    const contains: DistanceStation[] = [];
    for (const s of stations) {
        const names = [s.name, s.englishName ?? ''].map((n) => n.toLowerCase());
        if (names.some((n) => n.startsWith(q))) starts.push(s);
        else if (names.some((n) => n.includes(q))) contains.push(s);
        if (starts.length >= MAX_SUGGESTIONS) break;
    }
    return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
}

function StationPicker({ id, label, stations, value, onChange }: {
    id: string;
    label: string;
    stations: DistanceStation[];
    value: DistanceStation | null;
    onChange: (s: DistanceStation | null) => void;
}) {
    // What is being typed; null = show the chosen station (so a swap by the parent shows through).
    const [draft, setDraft] = useState<string | null>(null);
    const text = draft ?? value?.name ?? '';
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const box = useRef<HTMLDivElement>(null);

    const options = useMemo(() => suggest(stations, text), [stations, text]);

    useEffect(() => {
        const close = (e: MouseEvent) => {
            if (box.current && !box.current.contains(e.target as Node)) {
                setOpen(false);
                setDraft(null);   // leaving half-typed text: back to the chosen station
            }
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, []);

    const pick = (s: DistanceStation) => {
        onChange(s);
        setDraft(null);
        setOpen(false);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, options.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
        else if (e.key === 'Enter' && open && options[active]) { e.preventDefault(); pick(options[active]); }
        else if (e.key === 'Escape') { setOpen(false); setDraft(null); }
    };

    return (
        <div ref={box} className="relative min-w-0 flex-1">
            <label htmlFor={id} className="label">{label}</label>
            <input
                id={id}
                className="input"
                role="combobox"
                aria-expanded={open}
                aria-controls={`${id}-list`}
                aria-autocomplete="list"
                autoComplete="off"
                placeholder="Започни да пишеш…"
                value={text}
                onFocus={(e) => { e.target.select(); setOpen(true); }}
                onChange={(e) => {
                    setDraft(e.target.value);
                    setActive(0);
                    setOpen(true);
                    if (value) onChange(null);   // editing the text un-picks the station
                }}
                onKeyDown={onKeyDown}
            />
            {open && options.length > 0 && (
                <ul
                    id={`${id}-list`}
                    role="listbox"
                    className="card absolute z-20 mt-1 max-h-72 w-full overflow-y-auto py-1"
                >
                    {options.map((s, i) => (
                        <li
                            key={s.id}
                            role="option"
                            aria-selected={i === active}
                            onMouseEnter={() => setActive(i)}
                            onMouseDown={(e) => { e.preventDefault(); pick(s); }}
                            className={`cursor-pointer px-3 py-2 text-sm ${i === active ? 'bg-sunken' : ''}`}
                        >
                            {s.name}
                            {s.englishName && <span className="ml-2 text-xs text-muted">{s.englishName}</span>}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export default function DistanceCalculator() {
    const [stations, setStations] = useState<DistanceStation[]>([]);
    const [from, setFrom] = useState<DistanceStation | null>(null);
    const [to, setTo] = useState<DistanceStation | null>(null);
    const [result, setResult] = useState<DistanceResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const requestId = useRef(0);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/admin/distance/stations');
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Списъкът с гари не се зареди');
                setStations(data.stations);
            } catch (e) {
                setError(e instanceof Error ? e.message : 'Списъкът с гари не се зареди');
            }
        })();
    }, []);

    // Measured as soon as both stations are chosen.
    useEffect(() => {
        if (!from || !to) { setResult(null); return; }
        const id = ++requestId.current;
        setLoading(true);
        setError(null);
        (async () => {
            try {
                const res = await fetch(`/api/admin/distance?from=${from.id}&to=${to.id}`);
                const data = await res.json();
                if (id !== requestId.current) return;   // a newer pair was chosen meanwhile
                if (!res.ok) throw new Error(data.error || 'Разстоянието не се изчисли');
                setResult(data);
            } catch (e) {
                if (id === requestId.current) {
                    setResult(null);
                    setError(e instanceof Error ? e.message : 'Разстоянието не се изчисли');
                }
            } finally {
                if (id === requestId.current) setLoading(false);
            }
        })();
    }, [from, to]);

    const swap = () => { setFrom(to); setTo(from); };

    return (
        <div className="view-enter space-y-6">
            <div>
                <h2 className="page-title">Разстояния</h2>
                <p className="page-sub">
                    Разстояние по трасето между две гари в километри. Мери се по геометрията на линията
                    от влак, който минава през двете гари.
                </p>
            </div>

            <div className="card card-pad">
                <div className="flex flex-wrap items-end gap-3">
                    <StationPicker id="dist-from" label="От гара" stations={stations} value={from} onChange={setFrom} />
                    <button
                        type="button"
                        aria-label="Размени гарите"
                        className="btn btn-secondary btn-icon"
                        disabled={!from && !to}
                        onClick={swap}
                    >
                        <ArrowLeftRight size={16} aria-hidden="true" />
                    </button>
                    <StationPicker id="dist-to" label="До гара" stations={stations} value={to} onChange={setTo} />
                </div>
            </div>

            {error && (
                <div className="alert alert-danger" role="alert">
                    <CircleAlert size={16} aria-hidden="true" />
                    <span>{error}</span>
                </div>
            )}

            {result && !loading && (
                result.found ? (
                    <div className="card card-pad">
                        <p className="text-[0.8125rem] text-muted">{result.from.name} → {result.to.name}</p>
                        <p className="num mt-2 text-5xl font-bold tracking-tight">
                            {fmtKm(result.km ?? 0)} <span className="text-2xl font-semibold text-muted">км</span>
                        </p>
                        <dl className="mt-5 space-y-2 border-t border-line pt-4 text-[0.8125rem]">
                            {result.airKm != null && (
                                <div className="flex items-baseline justify-between gap-4">
                                    <dt className="text-muted">По въздушна линия</dt>
                                    <dd className="num font-medium">{fmtKm(result.airKm)} км</dd>
                                </div>
                            )}
                            {(result.shapes ?? 0) > 1 && (
                                <div className="flex items-baseline justify-between gap-4">
                                    <dt className="text-muted">Измерено по {result.shapes} различни трасета</dt>
                                    <dd className="num font-medium">{fmtKm(result.minKm ?? 0)} – {fmtKm(result.maxKm ?? 0)} км</dd>
                                </div>
                            )}
                            {result.exampleTrain && (
                                <div className="flex items-baseline justify-between gap-4">
                                    <dt className="text-muted">Измерено по влак</dt>
                                    <dd className="num font-medium">{result.exampleTrain}</dd>
                                </div>
                            )}
                        </dl>
                    </div>
                ) : (
                    <div className="alert alert-info" role="status">
                        <Info size={16} aria-hidden="true" />
                        <span>
                            Няма влак, който да минава през двете гари, така че не мога да измеря разстояние по трасето
                            — вероятно не са на една линия.
                            {result.airKm != null && <> По въздушна линия са {fmtKm(result.airKm)} км.</>}
                        </span>
                    </div>
                )
            )}
        </div>
    );
}
