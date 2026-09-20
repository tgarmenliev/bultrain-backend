import { useState } from 'react';
import { CircleAlert, Info, Upload } from 'lucide-react';

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

    const fileInput =
        'block w-full text-sm text-muted file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-line-strong ' +
        'file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink ' +
        'hover:file:bg-sunken file:transition-colors';

    return (
        <section className="space-y-4">
            <div className="flex items-end justify-between gap-4">
                <div>
                    <h2 className="section-title">Синхронизация на данни</h2>
                    <p className="page-sub">Прикачете ZIP архив с BDZ данни и опционално файл с невалидни влакове.</p>
                </div>
                {result && (
                    <button onClick={() => setResult(null)} className="btn btn-ghost btn-sm shrink-0">
                        Изчисти резултата
                    </button>
                )}
            </div>

            {!result ? (
                <div className="card card-pad space-y-5">
                    <div>
                        <label className="label">1. ZIP архив с разписания (задължително)</label>
                        <input
                            type="file"
                            accept=".zip"
                            onChange={(e) => setZipFile(e.target.files?.[0] || null)}
                            className={fileInput}
                        />
                    </div>

                    <div>
                        <label className="label">2. Файл с невалидни влакове (опционално)</label>
                        <input
                            type="file"
                            accept=".txt,.json"
                            onChange={(e) => setFailedTrainsFile(e.target.files?.[0] || null)}
                            className={fileInput}
                        />
                        <p className="hint mt-2">Текстов файл или JSON, съдържащ номерата на влакове за изтриване.</p>
                    </div>

                    <button
                        onClick={processUpload}
                        disabled={!zipFile || uploading}
                        className="btn btn-primary w-full"
                    >
                        {uploading ? (
                            <>
                                <svg className="h-4 w-4 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                Обработка и синхронизация...
                            </>
                        ) : (
                            <>
                                <Upload size={16} strokeWidth={2} aria-hidden="true" />
                                Стартирай импортиране
                            </>
                        )}
                    </button>
                </div>
            ) : (
                <div className="card card-pad space-y-4">
                    <div className="flex items-center gap-2">
                        <span className="badge badge-success">Успех</span>
                        <h3 className="section-title">Импортирането приключи</h3>
                    </div>

                    <ul className="space-y-2 text-sm">
                        <li className="flex items-baseline justify-between gap-4 border-b border-line pb-2">
                            <span className="text-muted">Обновени / добавени разписания</span>
                            <strong className="num font-semibold">{result.schedulesUpdated}</strong>
                        </li>
                        <li className="flex items-baseline justify-between gap-4 border-b border-line pb-2">
                            <span className="text-muted">Изтрити стари разписания (от файла с грешки)</span>
                            <strong className="num font-semibold">{result.schedulesDeleted}</strong>
                        </li>
                        <li className="flex items-baseline justify-between gap-4">
                            <span className="text-muted">Изтрити неактивни влакове (без разписания)</span>
                            <strong className="num font-semibold">{result.trainsDeleted}</strong>
                        </li>
                    </ul>

                    {result.deletedTrainNumbers && result.deletedTrainNumbers.length > 0 && (
                        <div className="border-t border-line pt-4">
                            <p className="hint mb-2">Изтрити номера на влакове:</p>
                            <div className="flex flex-wrap gap-1.5">
                                {result.deletedTrainNumbers.map((num) => (
                                    <span key={num} className="badge num font-mono">{num}</span>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {error && (
                <div role="alert" className="alert alert-danger">
                    <CircleAlert size={16} aria-hidden="true" />
                    <span>{error}</span>
                </div>
            )}

            <div className="alert alert-info block">
                <h4 className="mb-2 flex items-center gap-2 text-[0.8125rem] font-semibold">
                    <Info size={15} className="text-link" aria-hidden="true" />
                    Как работи синхронизацията?
                </h4>
                <ul className="list-disc space-y-1.5 pl-5 text-[0.8125rem] text-muted">
                    <li>Системата автоматично разархивира качените JSON файлове и ги сравнява с базата данни.</li>
                    <li>Опционалният файл за грешки изтрива стари и невалидни разписания.</li>
                    <li>Накрая всички влакове, които са останали без нито едно разписание, се премахват напълно.</li>
                </ul>
            </div>
        </section>
    );
}
