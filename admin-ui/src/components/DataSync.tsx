import { useState, useCallback } from 'react';

interface SyncResult {
    added: number;
    updated: number;
    skipped: number;
    errors: number;
    errorDetails: string[];
    total: number;
    message?: string;
}

export default function DataSync() {
    const [isDragging, setIsDragging] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<SyncResult | null>(null);
    const [showErrors, setShowErrors] = useState(false);

    const onDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const onDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    }, []);

    const processFile = async (file: File) => {
        if (file.type !== 'application/zip' && !file.name.endsWith('.zip')) {
            setError('Моля, прикачете валиден .zip архив.');
            return;
        }

        setError(null);
        setResult(null);
        setShowErrors(false);
        setUploading(true);

        const formData = new FormData();
        formData.append('file', file);

        try {
            const response = await fetch('/api/admin/upload-all', {
                method: 'POST',
                body: formData,
            });

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Грешка при качване на данните');
            }

            setResult(data);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setUploading(false);
            setIsDragging(false);
        }
    };

    const onDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) processFile(file);
    }, []);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) processFile(file);
    };

    return (
        <section className="space-y-6">
            <div className="flex justify-between items-end">
                <div>
                    <h2 className="text-2xl font-bold text-white">Синхронизация на данни</h2>
                    <p className="text-slate-400 text-sm mt-1">Прикачете ZIP архив с BDZ данни за пълно обновяване на системата.</p>
                </div>
                {result && (
                    <button 
                        onClick={() => { setResult(null); setShowErrors(false); }}
                        className="text-xs font-bold text-slate-500 hover:text-white transition-colors uppercase tracking-widest"
                    >
                        Изчисти Резултат
                    </button>
                )}
            </div>

            {!result ? (
                <div
                    onDragOver={onDragOver}
                    onDragLeave={onDragLeave}
                    onDrop={onDrop}
                    className={`
                        relative group overflow-hidden
                        min-h-[220px] rounded-3xl border-2 border-dashed transition-all duration-500 flex flex-col items-center justify-center p-8
                        ${isDragging 
                            ? 'border-indigo-500 bg-indigo-500/10 shadow-[0_0_40px_rgba(99,102,241,0.2)] scale-[1.01]' 
                            : 'border-white/10 glass-card bg-white/5 hover:border-white/20 hover:bg-white/[0.07]'}
                    `}
                >
                    <input 
                        type="file" 
                        accept=".zip"
                        onChange={handleFileSelect}
                        className="absolute inset-0 opacity-0 cursor-pointer z-10"
                        id="zip-upload"
                    />
                    
                    {uploading ? (
                        <div className="flex flex-col items-center animate-in-fade">
                            <div className="w-12 h-12 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin mb-4"></div>
                            <p className="text-indigo-400 font-bold tracking-wide">Обработка и синхронизация...</p>
                            <p className="text-slate-500 text-xs mt-2">Това може да отнеме няколко секунди.</p>
                        </div>
                    ) : (
                        <>
                            <div className={`
                                w-16 h-16 rounded-2xl flex items-center justify-center mb-4 transition-all duration-500
                                ${isDragging ? 'bg-indigo-500 text-white scale-110 rotate-3' : 'bg-white/5 text-slate-400 group-hover:text-white group-hover:scale-105'}
                            `}>
                                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                            </div>
                            <h3 className="text-lg font-bold text-white mb-1">
                                {isDragging ? 'Пуснете архива тук' : 'Плъзнете ZIP архив тук'}
                            </h3>
                            <p className="text-slate-400 text-sm text-center max-w-sm">
                                или <span className="text-indigo-400 font-bold underline decoration-indigo-500/30 underline-offset-4">изберете файл</span> от вашия компютър
                            </p>
                        </>
                    )}
                </div>
            ) : (
                <div className="space-y-4 animate-in-slide-up">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="p-4 glass-card rounded-2xl border-emerald-500/20 bg-emerald-500/5">
                            <p className="text-[10px] font-black tracking-widest text-emerald-500/60 uppercase mb-1">Добавени</p>
                            <p className="text-3xl font-black text-emerald-400">{result.added}</p>
                        </div>
                        <div className="p-4 glass-card rounded-2xl border-indigo-500/20 bg-indigo-500/5">
                            <p className="text-[10px] font-black tracking-widest text-indigo-500/60 uppercase mb-1">Обновени</p>
                            <p className="text-3xl font-black text-indigo-400">{result.updated}</p>
                        </div>
                        <div className="p-4 glass-card rounded-2xl border-slate-500/20 bg-white/5">
                            <p className="text-[10px] font-black tracking-widest text-slate-500 uppercase mb-1">Пропуснати</p>
                            <p className="text-3xl font-black text-slate-300">{result.skipped}</p>
                        </div>
                        <button 
                            onClick={() => result.errors > 0 && setShowErrors(!showErrors)}
                            className={`p-4 glass-card rounded-2xl border-rose-500/20 transition-all duration-300 ${result.errors > 0 ? 'bg-rose-500/10 cursor-pointer hover:border-rose-500/40 hover:shadow-[0_0_20px_rgba(244,63,94,0.1)]' : 'bg-rose-500/5 opacity-50'}`}
                        >
                            <p className="text-[10px] font-black tracking-widest text-rose-500/60 uppercase mb-1">Грешки</p>
                            <div className="flex justify-between items-center">
                                <p className="text-3xl font-black text-rose-400">{result.errors}</p>
                                {result.errors > 0 && (
                                    <svg className={`text-rose-500/40 transition-transform duration-500 ${showErrors ? 'rotate-180' : ''}`} xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                                )}
                            </div>
                        </button>
                    </div>

                    {showErrors && result.errorDetails && result.errorDetails.length > 0 && (
                        <div className="glass-card rounded-2xl border-rose-500/30 overflow-hidden animate-in-slide-down">
                            <div className="bg-rose-500/10 px-6 py-3 border-b border-rose-500/20">
                                <h4 className="text-xs font-black text-rose-400 uppercase tracking-widest">Детайли за грешките</h4>
                            </div>
                            <div className="max-h-60 overflow-y-auto custom-scrollbar p-4 space-y-2">
                                {result.errorDetails.map((msg, idx) => (
                                    <div key={idx} className="flex items-start text-xs text-rose-300/80 bg-rose-500/5 p-3 rounded-xl border border-rose-500/10">
                                        <div className="w-1.5 h-1.5 rounded-full bg-rose-500 mt-1 mr-3 shrink-0"></div>
                                        {msg}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {result.message && (
                        <div className="p-3 bg-white/5 rounded-xl border border-white/5 text-xs text-slate-400 flex items-center italic">
                            <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 mr-2 shrink-0"></div>
                            {result.message}
                        </div>
                    )}
                </div>
            )}

            {error && (
                <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-center text-rose-400 animate-in-shake">
                    <svg className="mr-3 shrink-0" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    <p className="text-sm font-bold">{error}</p>
                </div>
            )}

            <div className="p-5 glass-card rounded-2xl border-white/5 opacity-60">
                <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3 flex items-center">
                    <svg className="mr-2" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                    Как работи синхронизацията?
                </h4>
                <ul className="space-y-2">
                    <li className="text-[13px] text-slate-400 flex items-start leading-relaxed">
                        <span className="text-indigo-400 font-bold mr-2">•</span>
                        Системата автоматично разархивира качените JSON файлове и ги сравнява с базата данни.
                    </li>
                    <li className="text-[13px] text-slate-400 flex items-start leading-relaxed">
                        <span className="text-indigo-400 font-bold mr-2">•</span>
                        Ако бъде открита промяна в разписанието на даден влак, старата информация се изтрива и се заменя с новата.
                    </li>
                    <li className="text-[13px] text-slate-400 flex items-start leading-relaxed">
                        <span className="text-indigo-400 font-bold mr-2">•</span>
                        Ако влакът е нов, той се добавя автоматично. Ако няма промени, влакът се прескача за по-бърза работа.
                    </li>
                </ul>
            </div>
        </section>
    );
}
