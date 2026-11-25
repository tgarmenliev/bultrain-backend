import { useState, useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowDown, ArrowLeft, ArrowUp, Copy, ExternalLink, Plus, X } from 'lucide-react';
import { DESKTOP, TOUCH, useMediaQuery } from '../useMediaQuery';

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

/** What "saved" is compared by: everything the author types, not id or status. */
const contentKey = (e: Editing) => JSON.stringify([
    e.title, e.subtitle, e.language, e.cover_image, e.featured,
    e.region, e.season, e.duration_min, e.related_train, e.blocks,
]);

// Shrink in the browser BEFORE upload: cap the long edge at 1600px and re-encode
// as JPEG ~0.82. Crisp on any phone (retina included), but a 4.5 MB photo becomes
// a few hundred KB, so the upload is fast. Transparency is flattened onto white.
// Falls back to the original on any failure or if the result isn't smaller.
const MAX_DIM = 1600;
const JPEG_QUALITY = 0.82;
async function compressImage(file: File): Promise<File> {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
        const w = Math.round(bitmap.width * scale);
        const h = Math.round(bitmap.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return file;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bitmap, 0, 0, w, h);
        bitmap.close?.();
        const blob: Blob | null = await new Promise(r => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY));
        if (!blob || blob.size >= file.size) return file;
        return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch {
        return file;
    }
}

async function uploadImage(file: File): Promise<string> {
    const toSend = await compressImage(file);
    const fd = new FormData();
    fd.append('file', toSend);
    const res = await fetch('/api/admin/media', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Качването се провали');
    return data.filename as string;
}

interface Props {
    category?: 'travel_idea' | 'guide';
    /** Tells the app an article is open, so a phone can give it the bottom of the screen. */
    onEditingChange?: (editing: boolean) => void;
}

export default function ArticlesManager({ category = 'travel_idea', onEditingChange }: Props) {
    const isGuide = category === 'guide';
    // Guide topics are official app content (how to read a departure board, what
    // a Desiro is) — travel/trip metadata doesn't apply to them, so that whole
    // section of the form is hidden rather than left showing empty fields.
    const L = {
        heading: isGuide ? 'Справочник' : 'Идеи за пътуване',
        sub: isGuide ? 'Съдържание на наръчника в приложението.' : 'Статии за еднодневни пътувания с влак.',
        newBtn: isGuide ? 'Нова тема' : 'Нова статия',
        empty: isGuide ? 'Още няма теми. Създай първата.' : 'Още няма статии. Създай първата.',
        loadError: isGuide ? 'Темата не се зареди' : 'Статията не се зареди',
        deleteConfirm: isGuide ? 'Да изтрия ли темата?' : 'Да изтрия ли статията?',
        createdMsg: isGuide ? 'Темата е създадена (чернова).' : 'Статията е създадена (чернова).',
    };

    const [items, setItems] = useState<ListItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [ed, setEd] = useState<Editing | null>(null);
    const [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState<{ url: string; deepLink: string } | null>(null);

    const [copied, setCopied] = useState(false);
    const desktop = useMediaQuery(DESKTOP);
    const touch = useMediaQuery(TOUCH);
    const savedKey = useRef('');
    const errorRef = useRef<HTMLDivElement>(null);
    const previewRef = useRef<HTMLDivElement>(null);

    const isOpen = ed !== null;
    useEffect(() => {
        onEditingChange?.(isOpen);
        window.scrollTo(0, 0);
        return () => onEditingChange?.(false);
    }, [isOpen, onEditingChange]);

    // The buttons may be a screen away from where the answer to them appears.
    useEffect(() => { if (error) errorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [error]);
    useEffect(() => { if (preview) previewRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [preview]);

    const fetchList = async () => {
        try {
            setLoading(true);
            const res = await fetch(`/api/admin/articles?category=${category}`);
            if (!res.ok) throw new Error('Грешка при зареждане');
            setItems(await res.json());
        } catch (e: any) { setError(e.message); } finally { setLoading(false); }
    };
    useEffect(() => { fetchList(); }, [category]);

    const open = (next: Editing) => { savedKey.current = contentKey(next); setEd(next); };
    const openNew = () => { setPreview(null); open(empty()); };
    const leave = () => {
        if (ed && contentKey(ed) !== savedKey.current && !confirm('Има незаписани промени. Да ги изхвърля ли?')) return;
        setEd(null);
    };
    const openEdit = async (id: number) => {
        setError(null); setPreview(null);
        const res = await fetch(`/api/admin/articles/${id}`);
        if (!res.ok) { setError(L.loadError); return; }
        const a = await res.json();
        open({
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
        const sentKey = contentKey(ed);
        try {
            const payload: Record<string, unknown> = {
                title: ed.title, subtitle: ed.subtitle, language: ed.language,
                cover_image: ed.cover_image, featured: ed.featured, region: ed.region,
                season: ed.season, duration_min: ed.duration_min ? Number(ed.duration_min) : null,
                related_train: ed.related_train, blocks: ed.blocks,
            };
            // Only meaningful on create — an existing row's category is fixed
            // server-side and can never be reassigned via update.
            if (!ed.id) payload.category = category;
            const res = await fetch(ed.id ? `/api/admin/articles/${ed.id}` : '/api/admin/articles', {
                method: ed.id ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Записът се провали');
            const id = ed.id || data.id;
            savedKey.current = sentKey;
            // keep whatever was typed while the request was in flight
            if (!ed.id) setEd(cur => cur ? { ...cur, id } : cur);
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
        if (res.ok) { setCopied(false); setPreview({ url: data.url, deepLink: data.deepLink }); }
    };

    const del = async (id: number) => {
        if (!confirm(L.deleteConfirm)) return;
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
            <div key="list" className="view-enter space-y-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <h2 className="page-title">{L.heading}</h2>
                        <p className="page-sub">{L.sub}</p>
                    </div>
                    <button onClick={openNew} className="btn btn-primary shrink-0"><Plus size={16} strokeWidth={2.25} aria-hidden="true" />{L.newBtn}</button>
                </div>
                {error && <ErrorBox msg={error} />}
                {loading ? <p className="text-muted">Зареждане…</p> : items.length === 0 ? (
                    <div className="card card-pad text-center text-muted">{L.empty}</div>
                ) : (
                    <ul className="card divide-list overflow-hidden">
                        {items.map(a => (
                            <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4 sm:flex-nowrap">
                                <div className="h-12 w-[4.5rem] shrink-0 self-start overflow-hidden rounded-md bg-sunken sm:self-center">
                                    {a.cover_image && <img src={IMG(a.cover_image)} alt="" loading="lazy" className="h-full w-full object-cover" />}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                                        <h3 className="line-clamp-2 min-w-0 break-words font-medium sm:line-clamp-1">{a.title}</h3>
                                        <span className="flex gap-2">
                                            <StatusBadge status={a.status} />
                                            {!isGuide && !!a.featured && <span className="badge badge-accent">Топ</span>}
                                        </span>
                                    </div>
                                    {!isGuide && (
                                        <p className="mt-1 line-clamp-2 text-[0.8125rem] text-muted sm:mt-0.5 sm:line-clamp-1">
                                            {[a.region, a.season, a.duration_min ? `${a.duration_min} мин` : null, a.related_train ? `влак ${a.related_train}` : null].filter(Boolean).join(' · ') || '—'}
                                        </p>
                                    )}
                                </div>
                                <div className="flex w-full gap-2 sm:w-auto">
                                    <button onClick={() => openEdit(a.id)} className="btn btn-secondary btn-sm flex-1 sm:flex-none">Редактирай</button>
                                    <button onClick={() => del(a.id)} className="btn btn-danger btn-sm">Изтрий</button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        );
    }

    // ═══════════ EDITOR ═══════════
    const actions = (
        <>
            <button onClick={save} disabled={busy} className="btn btn-secondary">{busy ? 'Записване…' : desktop ? 'Запази чернова' : 'Запази'}</button>
            <button onClick={makePreview} className="btn btn-secondary">{desktop ? 'Линк за преглед' : 'Преглед'}</button>
            {ed.status === 'published'
                ? <button onClick={() => setStatus('unpublish')} className="btn btn-secondary">Скрий</button>
                : <button onClick={() => setStatus('publish')} className="btn btn-primary">Публикувай</button>}
        </>
    );

    return (
        <>
        <div key="editor" className="view-enter space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <button onClick={leave} className="btn btn-ghost btn-sm -ml-2.5"><ArrowLeft size={15} strokeWidth={2} aria-hidden="true" />Назад към списъка</button>
                <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={ed.status} />
                    {desktop && actions}
                </div>
            </div>

            {error && <div ref={errorRef}><ErrorBox msg={error} /></div>}
            {preview && (
                <div ref={previewRef} className="card card-pad flex flex-col items-center gap-5 sm:flex-row">
                    {/* a phone cannot scan its own screen: there it opens the link instead */}
                    <div className={`shrink-0 rounded-lg border border-line bg-white p-3 ${touch ? 'hidden sm:block' : ''}`}>
                        <QRCodeSVG value={preview.deepLink} size={240} />
                    </div>
                    <div className="w-full min-w-0 space-y-2 text-sm">
                        <p className="section-title">Преглед в приложението (важи 30 мин)</p>
                        <p className="text-muted">
                            {touch
                                ? 'Отвори черновата в приложението на това устройство или копирай линка.'
                                : 'Сканирай QR кода с телефона си, за да отвориш черновата директно в приложението.'}
                        </p>
                        {touch && (
                            <div className="flex flex-col gap-2 sm:flex-row">
                                <a href={preview.deepLink} className="btn btn-primary"><ExternalLink size={16} aria-hidden="true" />Отвори в приложението</a>
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => navigator.clipboard?.writeText(preview.deepLink).then(() => setCopied(true), () => setError('Линкът не се копира'))}
                                >
                                    <Copy size={16} aria-hidden="true" />{copied ? 'Копирано' : 'Копирай линка'}
                                </button>
                            </div>
                        )}
                        <p className="break-all font-mono text-xs text-muted">{preview.deepLink}</p>
                    </div>
                </div>
            )}

            <div className="grid gap-6 lg:grid-cols-2">
                {/* ── FORM ── */}
                <div className="min-w-0 space-y-5">
                    <div className="card card-pad space-y-4">
                        <Field label="Заглавие"><input className="input" value={ed.title} onChange={e => setEd({ ...ed, title: e.target.value })} /></Field>
                        <Field label="Подзаглавие"><input className="input" value={ed.subtitle} onChange={e => setEd({ ...ed, subtitle: e.target.value })} /></Field>
                        <Field label="Език">
                            <select className="input" value={ed.language} onChange={e => setEd({ ...ed, language: e.target.value as 'bg' | 'en' })}>
                                <option value="bg">Български</option>
                                <option value="en">English</option>
                            </select>
                        </Field>
                        <ImageField label="Корица" value={ed.cover_image} onUpload={async f => setEd({ ...ed, cover_image: await uploadImage(f) })} onClear={() => setEd({ ...ed, cover_image: null })} setError={setError} />
                        {!isGuide && (
                            <>
                                <div className="grid grid-cols-2 gap-3">
                                    <Field label="Регион"><input className="input" value={ed.region} onChange={e => setEd({ ...ed, region: e.target.value })} /></Field>
                                    <Field label="Сезон"><input className="input" value={ed.season} onChange={e => setEd({ ...ed, season: e.target.value })} placeholder="напр. есен" /></Field>
                                    <Field label="Времетраене (мин)"><input type="number" className="input" value={ed.duration_min} onChange={e => setEd({ ...ed, duration_min: e.target.value })} /></Field>
                                    <Field label="Свързан влак"><input className="input" value={ed.related_train} onChange={e => setEd({ ...ed, related_train: e.target.value })} placeholder="номер" /></Field>
                                </div>
                                <label className="flex items-center gap-2 text-sm font-medium pointer-coarse:min-h-11">
                                    <input type="checkbox" checked={ed.featured} onChange={e => setEd({ ...ed, featured: e.target.checked })} /> Featured
                                </label>
                            </>
                        )}
                    </div>

                    <div className="card card-pad space-y-3">
                        <h4 className="section-title">Съдържание</h4>
                        {ed.blocks.map((b, i) => (
                            <div key={i} className="space-y-2 rounded-lg border border-line bg-canvas p-3">
                                <div className="flex items-center gap-2">
                                    <span className="badge">{BLOCK_LABELS[b.block_type]}</span>
                                    <div className="ml-auto flex gap-1">
                                        <button onClick={() => moveBlock(i, -1)} aria-label="Премести нагоре" className="btn btn-ghost btn-icon btn-sm"><ArrowUp size={15} aria-hidden="true" /></button>
                                        <button onClick={() => moveBlock(i, 1)} aria-label="Премести надолу" className="btn btn-ghost btn-icon btn-sm"><ArrowDown size={15} aria-hidden="true" /></button>
                                        <button onClick={() => removeBlock(i)} aria-label="Премахни блока" className="btn btn-danger-ghost btn-icon btn-sm"><X size={15} aria-hidden="true" /></button>
                                    </div>
                                </div>
                                {b.block_type === 'image'
                                    ? <ImageField label="" value={b.image} onUpload={async f => patchBlock(i, { image: await uploadImage(f) })} onClear={() => patchBlock(i, { image: null })} setError={setError} caption={b.text_body} onCaption={v => patchBlock(i, { text_body: v })} />
                                    : <textarea className="input min-h-[70px]" value={b.text_body} onChange={e => patchBlock(i, { text_body: e.target.value })} placeholder={b.block_type === 'route' ? 'Напр. Влак 10112 · София → Копривщица' : 'Текст…'} />}
                            </div>
                        ))}
                        <div className="flex flex-wrap gap-2 pt-1">
                            {(Object.keys(BLOCK_LABELS) as BlockType[]).map(t => (
                                <button key={t} onClick={() => addBlock(t)} className="btn btn-secondary btn-sm"><Plus size={13} strokeWidth={2.25} aria-hidden="true" />{BLOCK_LABELS[t]}</button>
                            ))}
                        </div>
                    </div>
                </div>

                {/* ── LIVE PREVIEW ── */}
                <div className="h-fit min-w-0 lg:sticky lg:top-0">
                    <p className="hint mb-2">Преглед</p>
                    <div className="card overflow-hidden">
                        {ed.cover_image && <img src={IMG(ed.cover_image)} alt="" className="h-44 w-full object-cover" />}
                        <div className="space-y-3 p-5">
                            <h1 className="text-2xl font-semibold tracking-tight">{ed.title || 'Без заглавие'}</h1>
                            {ed.subtitle && <p className="text-muted">{ed.subtitle}</p>}
                            {!isGuide && (ed.region || ed.season || ed.duration_min || ed.related_train) && (
                                <p className="text-xs font-medium text-link">{[ed.region, ed.season, ed.duration_min && `${ed.duration_min} мин`, ed.related_train && `влак ${ed.related_train}`].filter(Boolean).join(' · ')}</p>
                            )}
                            <div className="space-y-3 pt-2">
                                {ed.blocks.map((b, i) => <PreviewBlock key={i} b={b} />)}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        {/* outside the animated view: a transformed parent would unpin a fixed bar */}
        {!desktop && <div className="action-bar">{actions}</div>}
        </>
    );
}

// ── small pieces ──
function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return <label className="block">{label && <span className="label">{label}</span>}{children}</label>;
}
function ErrorBox({ msg }: { msg: string }) {
    return <div role="alert" className="alert alert-danger">{msg}</div>;
}
function StatusBadge({ status }: { status: string }) {
    const pub = status === 'published';
    return <span className={`badge badge-dot ${pub ? 'badge-success' : ''}`}>{pub ? 'Публикувана' : 'Чернова'}</span>;
}
function ImageField({ label, value, onUpload, onClear, setError, caption, onCaption }: {
    label: string; value: string | null; onUpload: (f: File) => Promise<void>; onClear: () => void;
    setError: (s: string) => void; caption?: string; onCaption?: (v: string) => void;
}) {
    const [up, setUp] = useState(false);
    return (
        <div className="space-y-2">
            {label && <span className="label">{label}</span>}
            <div className="flex items-center gap-3">
                <div className="h-16 w-24 shrink-0 overflow-hidden rounded-md border border-line bg-sunken">
                    {value && <img src={IMG(value)} alt="" className="h-full w-full object-cover" />}
                </div>
                <div className="flex items-center gap-2">
                    <label className="btn btn-secondary btn-sm focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
                        {up ? 'Качване…' : (value ? 'Смени' : 'Качи')}
                        <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={async e => {
                            const f = e.target.files?.[0]; if (!f) return;
                            setUp(true); try { await onUpload(f); } catch (err: any) { setError(err.message); } finally { setUp(false); }
                        }} />
                    </label>
                    {value && <button onClick={onClear} className="btn btn-danger-ghost btn-sm">Махни</button>}
                </div>
            </div>
            {onCaption && <input className="input" value={caption || ''} onChange={e => onCaption(e.target.value)} placeholder="Надпис (по избор)" />}
        </div>
    );
}
function PreviewBlock({ b }: { b: Block }) {
    switch (b.block_type) {
        case 'heading': return <h2 className="text-lg font-semibold">{b.text_body}</h2>;
        case 'image': return b.image ? <figure><img src={IMG(b.image)} alt="" className="w-full rounded-lg" />{b.text_body && <figcaption className="mt-1 text-xs text-muted">{b.text_body}</figcaption>}</figure> : null;
        case 'quote': return <blockquote className="border-l-2 border-accent pl-3 italic text-muted">{b.text_body}</blockquote>;
        case 'tip': return <div className="rounded-lg border border-line bg-warning-soft p-3 text-sm">💡 {b.text_body}</div>;
        case 'route': return <div className="rounded-lg border border-line bg-accent-soft p-3 text-sm">🚆 {b.text_body}</div>;
        default: return <p className="leading-relaxed">{b.text_body}</p>;
    }
}
