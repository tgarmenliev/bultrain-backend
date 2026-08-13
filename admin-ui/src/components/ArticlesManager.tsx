import { useState, useEffect } from 'react';

type BlockType = 'heading' | 'paragraph' | 'image' | 'quote' | 'tip' | 'route';

interface Block { block_type: BlockType; text_body: string; image: string | null; }

interface ListItem {
    id: number; title: string; subtitle: string | null; status: string;
    featured: number; cover_image: string | null; region: string | null;
    season: string | null; duration_min: number | null; related_train: string | null;
    published_at: string | null; updated_at: string | null; author: string | null;
}

interface Editing {
    id: number | null; title: string; subtitle: string; language: 'bg' | 'en';
    cover_image: string | null; featured: boolean; region: string; season: string;
    duration_min: string; related_train: string; status: string; blocks: Block[];
}

const BLOCK_LABELS: Record<BlockType, string> = {
    heading: 'Заглавие', paragraph: 'Параграф', image: 'Картинка',
    quote: 'Цитат', tip: 'Съвет', route: 'Влак / маршрут',
};
const IMG = (name: string | null) => (name ? `/guide/images/${name}` : '');
const empty = (): Editing => ({
    id: null, title: '', subtitle: '', language: 'bg', cover_image: null, featured: false,
    region: '', season: '', duration_min: '', related_train: '', status: 'draft', blocks: [],
});

async function uploadImage(file: File): Promise<string> {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/admin/media', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Качването се провали');
    return data.filename as string;
}

export default function ArticlesManager() {
    const [items, setItems] = useState<ListItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [ed, setEd] = useState<Editing | null>(null);
    const [busy, setBusy] = useState(false);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);

    const fetchList = async () => {
        try {
            setLoading(true);
            const res = await fetch('/api/admin/articles');
            if (!res.ok) throw new Error('Грешка при зареждане');
            setItems(await res.json());
        } catch (e: any) { setError(e.message); } finally { setLoading(false); }
    };
    useEffect(() => { fetchList(); }, []);

    const openNew = () => { setPreviewUrl(null); setEd(empty()); };
    const openEdit = async (id: number) => {
        setError(null); setPreviewUrl(null);
        const res = await fetch(`/api/admin/articles/${id}`);
        if (!res.ok) { setError('Статията не се зареди'); return; }
        const a = await res.json();
        setEd({
            id: a.id, title: a.title || '', subtitle: a.subtitle || '', language: a.language || 'bg',
            cover_image: a.cover_image || null, featured: !!a.featured, region: a.region || '',
            season: a.season || '', duration_min: a.duration_min != null ? String(a.duration_min) : '',
            related_train: a.related_train || '', status: a.status || 'draft',
            blocks: (a.blocks || []).map((b: any) => ({ block_type: b.block_type, text_body: b.text_body || '', image: b.image || null })),
        });
    };

    const save = async (): Promise<number | null> => {
        if (!ed) return null;
        if (!ed.title.trim()) { setError('Заглавието е задължително'); return null; }
        setBusy(true); setError(null);
        try {
            const payload = {
                title: ed.title, subtitle: ed.subtitle, language: ed.language,
                cover_image: ed.cover_image, featured: ed.featured, region: ed.region,
                season: ed.season, duration_min: ed.duration_min ? Number(ed.duration_min) : null,
                related_train: ed.related_train, blocks: ed.blocks,
            };
            const res = await fetch(ed.id ? `/api/admin/articles/${ed.id}` : '/api/admin/articles', {
                method: ed.id ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Записът се провали');
            const id = ed.id || data.id;
            if (!ed.id) setEd({ ...ed, id });
            await fetchList();
            return id;
        } catch (e: any) { setError(e.message); return null; } finally { setBusy(false); }
    };

    const setStatus = async (action: 'publish' | 'unpublish') => {
        const id = await save();
        if (!id) return;
        const res = await fetch(`/api/admin/articles/${id}/${action}`, { method: 'POST' });
        if (res.ok) { setEd(e => e ? { ...e, status: action === 'publish' ? 'published' : 'draft' } : e); await fetchList(); }
    };

    const makePreview = async () => {
        const id = await save();
        if (!id) return;
        const res = await fetch(`/api/admin/articles/${id}/preview-token`, { method: 'POST' });
        const data = await res.json();
        if (res.ok) setPreviewUrl(data.url);
    };

    const del = async (id: number) => {
        if (!confirm('Да изтрия ли статията?')) return;
        const res = await fetch(`/api/admin/articles/${id}`, { method: 'DELETE' });
        if (res.ok) { setEd(null); await fetchList(); }
    };

    // ── block editing ──
    const addBlock = (t: BlockType) => setEd(e => e ? { ...e, blocks: [...e.blocks, { block_type: t, text_body: '', image: null }] } : e);
    const patchBlock = (i: number, p: Partial<Block>) => setEd(e => e ? { ...e, blocks: e.blocks.map((b, j) => j === i ? { ...b, ...p } : b) } : e);
    const moveBlock = (i: number, d: -1 | 1) => setEd(e => {
        if (!e) return e;
        const j = i + d; if (j < 0 || j >= e.blocks.length) return e;
        const b = [...e.blocks]; [b[i], b[j]] = [b[j], b[i]]; return { ...e, blocks: b };
    });
    const removeBlock = (i: number) => setEd(e => e ? { ...e, blocks: e.blocks.filter((_, j) => j !== i) } : e);

    // ═══════════ LIST ═══════════
    if (!ed) {
        return (
            <div className="space-y-8">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-3xl font-bold text-gradient">Идеи за пътуване</h2>
                        <p className="text-slate-400 text-sm mt-2">Статии за еднодневни пътувания с влак.</p>
                    </div>
                    <button onClick={openNew} className="btn-glow px-6 py-3">+ Нова статия</button>
                </div>
                {error && <ErrorBox msg={error} />}
                {loading ? <p className="text-slate-400">Зареждане…</p> : (
                    <div className="grid gap-4">
                        {items.length === 0 && <p className="text-slate-500">Още няма статии. Създай първата.</p>}
                        {items.map(a => (
                            <div key={a.id} className="glass-card rounded-2xl p-5 flex items-center gap-4">
                                <div className="w-20 h-14 rounded-lg bg-slate-800 overflow-hidden shrink-0">
                                    {a.cover_image && <img src={IMG(a.cover_image)} alt="" className="w-full h-full object-cover" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <h3 className="font-bold text-white truncate">{a.title}</h3>
                                        <StatusBadge status={a.status} />
                                        {!!a.featured && <span className="text-[10px] font-black uppercase text-purple-300 bg-purple-500/15 px-2 py-0.5 rounded-md border border-purple-500/25">Топ</span>}
                                    </div>
                                    <p className="text-xs text-slate-400 mt-1 truncate">
                                        {[a.region, a.season, a.duration_min ? `${a.duration_min} мин` : null, a.related_train ? `влак ${a.related_train}` : null].filter(Boolean).join(' · ') || '—'}
                                    </p>
                                </div>
                                <button onClick={() => openEdit(a.id)} className="px-4 py-2 rounded-lg text-sm font-bold text-indigo-300 bg-indigo-500/10 border border-indigo-500/25 hover:bg-indigo-500/20">Редактирай</button>
                                <button onClick={() => del(a.id)} className="px-3 py-2 rounded-lg text-sm font-bold text-rose-300 bg-rose-500/10 border border-rose-500/25 hover:bg-rose-500/20">Изтрий</button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    // ═══════════ EDITOR ═══════════
    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between gap-4 flex-wrap">
                <button onClick={() => setEd(null)} className="text-slate-400 hover:text-white text-sm font-bold">← Назад към списъка</button>
                <div className="flex items-center gap-2">
                    <StatusBadge status={ed.status} />
                    <button onClick={save} disabled={busy} className="px-4 py-2 rounded-lg text-sm font-bold text-slate-200 bg-slate-700/50 border border-white/10 hover:bg-slate-700 disabled:opacity-50">{busy ? 'Записване…' : 'Запази чернова'}</button>
                    <button onClick={makePreview} className="px-4 py-2 rounded-lg text-sm font-bold text-cyan-300 bg-cyan-500/10 border border-cyan-500/25 hover:bg-cyan-500/20">Линк за преглед</button>
                    {ed.status === 'published'
                        ? <button onClick={() => setStatus('unpublish')} className="px-4 py-2 rounded-lg text-sm font-bold text-amber-300 bg-amber-500/10 border border-amber-500/25 hover:bg-amber-500/20">Скрий</button>
                        : <button onClick={() => setStatus('publish')} className="btn-glow px-5 py-2 text-sm">Публикувай</button>}
                </div>
            </div>

            {error && <ErrorBox msg={error} />}
            {previewUrl && (
                <div className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-xs text-cyan-200 break-all">
                    Линк за преглед в приложението (30 мин): <span className="font-mono">{previewUrl}</span>
                </div>
            )}

            <div className="grid lg:grid-cols-2 gap-6">
                {/* ── FORM ── */}
                <div className="space-y-5">
                    <div className="glass-card rounded-2xl p-5 space-y-4">
                        <Field label="Заглавие"><input className="input-premium w-full" value={ed.title} onChange={e => setEd({ ...ed, title: e.target.value })} /></Field>
                        <Field label="Подзаглавие"><input className="input-premium w-full" value={ed.subtitle} onChange={e => setEd({ ...ed, subtitle: e.target.value })} /></Field>
                        <Field label="Език">
                            <select className="input-premium w-full" value={ed.language} onChange={e => setEd({ ...ed, language: e.target.value as 'bg' | 'en' })}>
                                <option value="bg">Български</option>
                                <option value="en">English</option>
                            </select>
                        </Field>
                        <ImageField label="Корица" value={ed.cover_image} onUpload={async f => setEd({ ...ed, cover_image: await uploadImage(f) })} onClear={() => setEd({ ...ed, cover_image: null })} setError={setError} />
                        <div className="grid grid-cols-2 gap-3">
                            <Field label="Регион"><input className="input-premium w-full" value={ed.region} onChange={e => setEd({ ...ed, region: e.target.value })} /></Field>
                            <Field label="Сезон"><input className="input-premium w-full" value={ed.season} onChange={e => setEd({ ...ed, season: e.target.value })} placeholder="напр. есен" /></Field>
                            <Field label="Времетраене (мин)"><input type="number" className="input-premium w-full" value={ed.duration_min} onChange={e => setEd({ ...ed, duration_min: e.target.value })} /></Field>
                            <Field label="Свързан влак"><input className="input-premium w-full" value={ed.related_train} onChange={e => setEd({ ...ed, related_train: e.target.value })} placeholder="номер" /></Field>
                        </div>
                        <label className="flex items-center gap-2 text-sm font-semibold text-slate-300">
                            <input type="checkbox" checked={ed.featured} onChange={e => setEd({ ...ed, featured: e.target.checked })} /> Открояване (топ)
                        </label>
                    </div>

                    <div className="glass-card rounded-2xl p-5 space-y-3">
                        <h4 className="text-sm font-black uppercase tracking-wider text-slate-400">Съдържание</h4>
                        {ed.blocks.map((b, i) => (
                            <div key={i} className="rounded-xl border border-white/10 bg-slate-900/40 p-3 space-y-2">
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-black uppercase text-purple-300 bg-purple-500/15 px-2 py-0.5 rounded">{BLOCK_LABELS[b.block_type]}</span>
                                    <div className="ml-auto flex gap-1">
                                        <button onClick={() => moveBlock(i, -1)} className="px-2 py-0.5 rounded text-xs font-bold text-slate-300 bg-slate-700/40 border border-white/10 hover:bg-slate-700">↑</button>
                                        <button onClick={() => moveBlock(i, 1)} className="px-2 py-0.5 rounded text-xs font-bold text-slate-300 bg-slate-700/40 border border-white/10 hover:bg-slate-700">↓</button>
                                        <button onClick={() => removeBlock(i)} className="px-2 py-0.5 rounded text-xs font-bold text-slate-300 bg-slate-700/40 border border-white/10 hover:bg-slate-700 !text-rose-300">✕</button>
                                    </div>
                                </div>
                                {b.block_type === 'image'
                                    ? <ImageField label="" value={b.image} onUpload={async f => patchBlock(i, { image: await uploadImage(f) })} onClear={() => patchBlock(i, { image: null })} setError={setError} caption={b.text_body} onCaption={v => patchBlock(i, { text_body: v })} />
                                    : <textarea className="input-premium w-full min-h-[70px]" value={b.text_body} onChange={e => patchBlock(i, { text_body: e.target.value })} placeholder={b.block_type === 'route' ? 'Напр. Влак 10112 · София → Копривщица' : 'Текст…'} />}
                            </div>
                        ))}
                        <div className="flex flex-wrap gap-2 pt-1">
                            {(Object.keys(BLOCK_LABELS) as BlockType[]).map(t => (
                                <button key={t} onClick={() => addBlock(t)} className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-300 bg-slate-700/40 border border-white/10 hover:bg-slate-700">+ {BLOCK_LABELS[t]}</button>
                            ))}
                        </div>
                    </div>
                </div>

                {/* ── LIVE PREVIEW ── */}
                <div className="lg:sticky lg:top-4 h-fit">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">Преглед</p>
                    <div className="rounded-3xl border border-white/10 bg-slate-950/60 overflow-hidden">
                        {ed.cover_image && <img src={IMG(ed.cover_image)} alt="" className="w-full h-44 object-cover" />}
                        <div className="p-5 space-y-3">
                            <h1 className="text-2xl font-black text-white">{ed.title || 'Без заглавие'}</h1>
                            {ed.subtitle && <p className="text-slate-400">{ed.subtitle}</p>}
                            {(ed.region || ed.season || ed.duration_min || ed.related_train) && (
                                <p className="text-xs text-purple-300">{[ed.region, ed.season, ed.duration_min && `${ed.duration_min} мин`, ed.related_train && `влак ${ed.related_train}`].filter(Boolean).join(' · ')}</p>
                            )}
                            <div className="space-y-3 pt-2">
                                {ed.blocks.map((b, i) => <PreviewBlock key={i} b={b} />)}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ── small pieces ──
function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return <div className="space-y-1.5">{label && <label className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</label>}{children}</div>;
}
function ErrorBox({ msg }: { msg: string }) {
    return <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-sm font-medium text-rose-400">{msg}</div>;
}
function StatusBadge({ status }: { status: string }) {
    const pub = status === 'published';
    return <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-md border ${pub ? 'text-emerald-300 bg-emerald-500/15 border-emerald-500/25' : 'text-slate-400 bg-slate-500/15 border-slate-500/25'}`}>{pub ? 'Публикувана' : 'Чернова'}</span>;
}
function ImageField({ label, value, onUpload, onClear, setError, caption, onCaption }: {
    label: string; value: string | null; onUpload: (f: File) => Promise<void>; onClear: () => void;
    setError: (s: string) => void; caption?: string; onCaption?: (v: string) => void;
}) {
    const [up, setUp] = useState(false);
    return (
        <div className="space-y-2">
            {label && <label className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</label>}
            <div className="flex items-center gap-3">
                <div className="w-24 h-16 rounded-lg bg-slate-800 overflow-hidden shrink-0 border border-white/10">
                    {value && <img src={IMG(value)} alt="" className="w-full h-full object-cover" />}
                </div>
                <div className="space-y-1">
                    <label className="px-3 py-1.5 rounded-lg text-xs font-bold text-indigo-300 bg-indigo-500/10 border border-indigo-500/25 hover:bg-indigo-500/20 cursor-pointer inline-block">
                        {up ? 'Качване…' : (value ? 'Смени' : 'Качи')}
                        <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={async e => {
                            const f = e.target.files?.[0]; if (!f) return;
                            setUp(true); try { await onUpload(f); } catch (err: any) { setError(err.message); } finally { setUp(false); }
                        }} />
                    </label>
                    {value && <button onClick={onClear} className="ml-2 text-xs text-rose-300 hover:underline">махни</button>}
                </div>
            </div>
            {onCaption && <input className="input-premium w-full text-sm" value={caption || ''} onChange={e => onCaption(e.target.value)} placeholder="Надпис (по избор)" />}
        </div>
    );
}
function PreviewBlock({ b }: { b: Block }) {
    switch (b.block_type) {
        case 'heading': return <h2 className="text-lg font-bold text-white">{b.text_body}</h2>;
        case 'image': return b.image ? <figure><img src={IMG(b.image)} alt="" className="w-full rounded-xl" />{b.text_body && <figcaption className="text-xs text-slate-500 mt-1">{b.text_body}</figcaption>}</figure> : null;
        case 'quote': return <blockquote className="border-l-2 border-purple-400 pl-3 italic text-slate-300">{b.text_body}</blockquote>;
        case 'tip': return <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3 text-sm text-emerald-200">💡 {b.text_body}</div>;
        case 'route': return <div className="rounded-xl bg-indigo-500/10 border border-indigo-500/20 p-3 text-sm text-indigo-200">🚆 {b.text_body}</div>;
        default: return <p className="text-slate-300 leading-relaxed">{b.text_body}</p>;
    }
}
