import {
    Activity, BookOpen, CalendarDays, MapPin, Radio, Smartphone, TrainFront,
    type LucideIcon,
} from 'lucide-react';
import DataSync from './DataSync';
import { FEATURES } from '../features';
import { formatDateBg, hoursSince, timeAgo, weekdayBg } from '../format';
import type { Overview } from '../types';

type Tone = 'success' | 'warning' | 'danger';

interface StatCardProps {
    label: string;
    value: string | number;
    hint?: string;
    Icon: LucideIcon;
}

function StatCard({ label, value, hint, Icon }: StatCardProps) {
    return (
        <div className="card card-pad">
            <div className="flex items-center justify-between">
                <h3 className="text-[0.8125rem] text-muted">{label}</h3>
                <Icon size={16} className="text-faint" aria-hidden="true" />
            </div>
            <p className="num mt-3 text-3xl font-bold tracking-tight">{value}</p>
            {hint && <p className="hint mt-1">{hint}</p>}
        </div>
    );
}

interface StatusRowProps {
    label: string;
    value: string;
    title?: string;
    badge?: { text: string; tone: Tone } | { text: string; tone?: undefined };
}

function StatusRow({ label, value, title, badge }: StatusRowProps) {
    return (
        <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-3">
            <span className="text-muted">{label}</span>
            <span className="flex items-center gap-2.5" title={title}>
                <span className="num font-medium">{value}</span>
                {badge && (
                    <span className={`badge badge-dot ${badge.tone ? `badge-${badge.tone}` : ''}`}>{badge.text}</span>
                )}
            </span>
        </li>
    );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default function Dashboard({ overview }: { overview: Overview | null }) {
    const o = overview;
    const g = o?.gtfs;

    // ── System status rows ───────────────────────────────────────────────────
    const rows: StatusRowProps[] = [];

    if (g) {
        if (!g.hasData) {
            rows.push({
                label: 'Разписание (GTFS)',
                value: 'Няма импортирани данни',
                badge: { text: 'липсва', tone: 'danger' },
            });
        } else {
            const left = g.daysLeft ?? 0;
            rows.push({
                label: 'Разписание (GTFS)',
                value: `${formatDateBg(g.from!)} – ${formatDateBg(g.to!)}`,
                badge:
                    left < 0 ? { text: 'изтекло', tone: 'danger' }
                    : left < 14 ? { text: `остават ${plural(left, 'ден', 'дни')}`, tone: 'warning' }
                    : { text: `${left} дни напред`, tone: 'success' },
            });
        }

        const age = hoursSince(g.importedAt);
        rows.push({
            label: 'Последен импорт',
            value: timeAgo(g.importedAt) ?? '—',
            title: g.importedAt ? `${g.importedAt}${g.feedVersion ? ` · версия ${g.feedVersion}` : ''}` : undefined,
            badge:
                g.importedAt == null ? undefined
                : g.importStatus && g.importStatus !== 'ok' ? { text: 'с грешка', tone: 'danger' }
                : age != null && age > 48 ? { text: 'остаряло', tone: 'warning' }
                : { text: 'наред', tone: 'success' },
        });
    }

    if (o) {
        const rt = o.realtime;
        rows.push({
            label: 'Реално време — обновления',
            value: rt ? plural(rt.trips, 'влак', 'влака') : 'Няма данни',
            title: rt?.tripFeedTs ? `Последно: ${timeAgo(rt.tripFeedTs)}` : undefined,
            badge: rt ? (rt.tripFresh ? { text: 'актуално', tone: 'success' } : { text: 'няма актуални данни', tone: 'danger' }) : undefined,
        });
        rows.push({
            label: 'Реално време — позиции',
            value: rt ? plural(rt.vehicles, 'влак', 'влака') : 'Няма данни',
            title: rt?.vehicleFeedTs ? `Последно: ${timeAgo(rt.vehicleFeedTs)}` : undefined,
            badge: rt ? (rt.vehicleFresh ? { text: 'актуално', tone: 'success' } : { text: 'няма актуални данни', tone: 'danger' }) : undefined,
        });

        rows.push({
            label: 'Закъснения днес',
            value: o.delays
                ? `${o.delays.avgDelayMin > 0 ? '+' : ''}${o.delays.avgDelayMin} мин средно · ${plural(o.delays.trainsObserved, 'влак', 'влака')}`
                : 'Още няма наблюдения',
            title: o.delays ? 'Средно от последно наблюдаваното закъснение на гарите днес' : undefined,
        });

        rows.push({
            label: 'Идеи за пътуване',
            value: `${o.content.ideasPublished} публикувани`,
            badge: o.content.ideasDraft > 0 ? { text: plural(o.content.ideasDraft, 'чернова', 'чернови') } : undefined,
        });
    }

    const liveVehicles = o?.realtime && o.realtime.vehicleFresh ? o.realtime.vehicles : null;

    return (
        <div className="view-enter space-y-8">
            <div>
                <h2 className="page-title">Общ изглед</h2>
                <p className="page-sub">Състоянието на данните и системата в момента.</p>
            </div>

            {FEATURES.scheduleUpload && <DataSync />}

            <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <StatCard
                    label="Общо влакове"
                    value={o?.trains ?? '—'}
                    hint={g?.hasData ? 'в записаните GTFS разписания' : g ? 'от старите данни' : undefined}
                    Icon={TrainFront}
                />
                <StatCard label="Общо гари" value={o?.stations ?? '—'} Icon={MapPin} />
                <StatCard label="Теми в справочника" value={o?.guideTopics ?? '—'} Icon={BookOpen} />
            </section>

            <section className="space-y-3">
                <h3 className="section-title">Днес</h3>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <StatCard
                        label="Влакове днес"
                        value={o?.today.trains ?? '—'}
                        hint={o ? `${weekdayBg(o.today.date)}, ${formatDateBg(o.today.date)}` : undefined}
                        Icon={CalendarDays}
                    />
                    <StatCard
                        label="На живо сега"
                        value={liveVehicles ?? '—'}
                        hint={o?.realtime ? (o.realtime.vehicleFresh ? 'влака с позиция' : 'няма актуални данни') : undefined}
                        Icon={Radio}
                    />
                    <StatCard
                        label="Следени пътувания"
                        value={o?.tracking?.started ?? '—'}
                        hint={o?.tracking ? `${o.tracking.armed} чакат старт` : undefined}
                        Icon={Activity}
                    />
                    <StatCard
                        label="Устройства"
                        value={o?.tracking?.devices ?? '—'}
                        hint={o?.tracking ? `iOS ${o.tracking.devicesIos} · Android ${o.tracking.devicesAndroid}` : undefined}
                        Icon={Smartphone}
                    />
                </div>
            </section>

            {rows.length > 0 && (
                <section className="space-y-3">
                    <h3 className="section-title">Състояние на системата</h3>
                    <ul className="card divide-list px-5">
                        {rows.map((r) => <StatusRow key={r.label} {...r} />)}
                    </ul>
                </section>
            )}
        </div>
    );
}
