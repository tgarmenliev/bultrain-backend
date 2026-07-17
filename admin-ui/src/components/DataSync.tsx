import { useState } from 'react';

interface SyncResult {
    schedulesUpdated: number;
    schedulesDeleted: number;
    trainsDeleted: number;
    deletedTrainNumbers: string[];
}

export default function DataSync() {
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<SyncResult | null>(null);
    
    const [zipFile, setZipFile] = useState<File | null>(null);
    const [failedTrainsFile, setFailedTrainsFile] = useState<File | null>(null);

    const processUpload = async () => {
        if (!zipFile) {
            setError('Моля, прикачете валиден .zip архив.');
            return;
        }

        setError(null);
        setResult(null);
        setUploading(true);

        const formData = new FormData();
        formData.append('file', zipFile);
        if (failedTrainsFile) {
            formData.append('failedTrains', failedTrainsFile);
        }

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
            setZipFile(null);
            setFailedTrainsFile(null);
        }
    };

    return (
        <section className="space-y-6">
            <div className="flex justify-between items-end">
                <div>
                    <h2 className="text-2xl font-bold text-white">Синхронизация на данни</h2>
                    <p className="text-slate-400 text-sm mt-1">Прикачете ZIP архив с BDZ данни и опционално файл с невалидни влакове.</p>
                </div>
                {result && (
                    <button 
                        onClick={() => setResult(null)}
                        className="text-xs font-bold text-slate-500 hover:text-white transition-colors uppercase tracking-widest"
                    >
                        Изчисти Резултат
                    </button>
                )}
            </div>

            {!result ? (
                <div className="glass-card rounded-3xl border border-white/10 p-8 space-y-6">
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-bold text-white mb-2">1. ZIP Архив с разписания (задължително)</label>
                            <input 
                                type="file" 
                                accept=".zip"
                                onChange={(e) => setZipFile(e.target.files?.[0] || null)}
                                className="block w-full text-sm text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-bold file:bg-indigo-500/20 file:text-indigo-400 hover:file:bg-indigo-500/30 transition-colors"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-bold text-white mb-2">2. Файл с невалидни влакове (опционално)</label>
                            <input 
                                type="file" 
                                accept=".txt,.json"
                                onChange={(e) => setFailedTrainsFile(e.target.files?.[0] || null)}
                                className="block w-full text-sm text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-bold file:bg-rose-500/20 file:text-rose-400 hover:file:bg-rose-500/30 transition-colors"
                            />
                            <p className="text-xs text-slate-500 mt-2">Текстов файл или JSON, съдържащ номерата на влакове за изтриване.</p>
                        </div>
                    </div>

                    <button 
                        onClick={processUpload}
                        disabled={!zipFile || uploading}
                        className={`w-full py-3 rounded-xl font-bold text-white transition-all duration-300 flex items-center justify-center
                            ${(!zipFile || uploading) ? 'bg-white/5 text-slate-500 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-500 hover:shadow-[0_0_20px_rgba(79,70,229,0.4)]'}`}
                    >
                        {uploading ? (
                            <>
                                <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                Обработка и синхронизация...
                            </>
                        ) : 'Стартирай импортиране'}
                    </button>
                </div>
            ) : (
                <div className="p-6 glass-card rounded-3xl border border-emerald-500/30 bg-emerald-500/5 animate-in-slide-up space-y-4">
                    <h3 className="text-xl font-bold text-emerald-400">Успешно импортиране! Извършени действия:</h3>
                    
                    <ul className="space-y-3 mt-4 text-slate-300 text-sm">
                        <li className="flex items-center">
                            <span className="w-2 h-2 rounded-full bg-emerald-500 mr-3"></span>
                            Обновени/Добавени разписания: <strong className="ml-2 text-white">{result.schedulesUpdated}</strong>
                        </li>
                        <li className="flex items-center">
                            <span className="w-2 h-2 rounded-full bg-rose-500 mr-3"></span>
                            Изтрити стари разписания (от файла с грешки): <strong className="ml-2 text-white">{result.schedulesDeleted}</strong>
                        </li>
                        <li className="flex items-center">
                            <span className="w-2 h-2 rounded-full bg-amber-500 mr-3"></span>
                            Изтрити неактивни влакове (без разписания): <strong className="ml-2 text-white">{result.trainsDeleted}</strong>
                        </li>
                    </ul>

                    {result.deletedTrainNumbers && result.deletedTrainNumbers.length > 0 && (
                        <div className="mt-6 pt-4 border-t border-white/10">
                            <p className="text-xs text-slate-400 mb-2">Изтрити номера на влакове:</p>
                            <div className="flex flex-wrap gap-2">
                                {result.deletedTrainNumbers.map((num) => (
                                    <span key={num} className="px-2 py-1 bg-white/5 border border-white/10 rounded text-xs text-slate-300">
                                        {num}
                                    </span>
                                ))}
                            </div>
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
                        Опционалният файл за грешки изтрива стари и невалидни разписания.
                    </li>
                    <li className="text-[13px] text-slate-400 flex items-start leading-relaxed">
                        <span className="text-indigo-400 font-bold mr-2">•</span>
                        Накрая всички влакове, които са останали без нито едно разписание, се премахват напълно.
                    </li>
                </ul>
            </div>
        </section>
    );
}
