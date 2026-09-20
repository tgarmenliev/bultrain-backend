import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, X } from 'lucide-react';
import Modal from './Modal';

const MIN_LENGTH = 8;

/** The server's answer, in words the person at the keyboard can act on. */
function messageFor(status: number, code?: string): string {
    if (status === 429) return 'Твърде много опити. Опитай пак след малко.';
    switch (code) {
        case 'wrong-old-password': return 'Старата парола не е вярна.';
        case 'too-short': return `Новата парола трябва да е поне ${MIN_LENGTH} символа.`;
        case 'too-long': return 'Паролата е твърде дълга.';
        case 'same-as-old': return 'Новата парола трябва да е различна от старата.';
        case 'account-not-found': return 'Този акаунт вече не съществува. Влез отново.';
        default: return 'Паролата не беше сменена. Опитай пак.';
    }
}

export default function PasswordModal({ onClose }: { onClose: () => void }) {
    // null while we ask the server whether this account's password can be changed here.
    const [canChange, setCanChange] = useState<boolean | null>(null);
    const [oldPassword, setOldPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch('/api/admin/account');
                const data = await res.json();
                if (!cancelled) setCanChange(res.ok ? !!data.canChangePassword : true);
            } catch {
                // If we cannot tell, show the form; the server still has the last word.
                if (!cancelled) setCanChange(true);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);

        if (newPassword.length < MIN_LENGTH) return setError(`Новата парола трябва да е поне ${MIN_LENGTH} символа.`);
        if (newPassword !== confirm) return setError('Двете нови пароли не съвпадат.');
        if (newPassword === oldPassword) return setError('Новата парола трябва да е различна от старата.');

        setBusy(true);
        try {
            const res = await fetch('/api/admin/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ oldPassword, newPassword }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                setError(messageFor(res.status, data.code));
                return;
            }
            setOldPassword('');
            setNewPassword('');
            setConfirm('');
            setDone(true);
        } catch {
            setError('Няма връзка със сървъра. Опитай пак.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal label="Смяна на парола" onClose={onClose}>
            {(close) => (
                <div className="modal-panel max-w-md">
                    <div className="flex items-center justify-between border-b border-line px-6 py-4">
                        <h3 className="text-lg font-semibold">Смяна на парола</h3>
                        <button onClick={close} aria-label="Затвори" className="btn btn-ghost btn-icon">
                            <X size={16} strokeWidth={2} aria-hidden="true" />
                        </button>
                    </div>

                    <div className="p-6">
                        {canChange === null ? (
                            <p className="py-6 text-center text-muted">Зареждане...</p>
                        ) : canChange === false ? (
                            <div className="space-y-5">
                                <div className="alert alert-info block">
                                    Този акаунт влиза с основната парола на сървъра (<code className="font-mono">ADMIN_PASSWORD</code> във
                                    файла <code className="font-mono">.env</code>), затова тя не може да се смени оттук.
                                    Сменя се директно на сървъра.
                                </div>
                                <div className="flex justify-end">
                                    <button type="button" onClick={close} className="btn btn-secondary">Затвори</button>
                                </div>
                            </div>
                        ) : done ? (
                            <div className="space-y-5">
                                <div role="status" className="alert alert-success">
                                    <CircleCheck size={16} aria-hidden="true" />
                                    <span>Паролата е сменена. Следващия път влез с новата.</span>
                                </div>
                                <div className="flex justify-end">
                                    <button type="button" onClick={close} className="btn btn-primary">Готово</button>
                                </div>
                            </div>
                        ) : (
                            <form onSubmit={submit} className="space-y-4">
                                <div>
                                    <label htmlFor="pw-old" className="label">Стара парола</label>
                                    <input
                                        id="pw-old"
                                        type="password"
                                        autoComplete="current-password"
                                        autoFocus
                                        className="input"
                                        value={oldPassword}
                                        onChange={(e) => setOldPassword(e.target.value)}
                                    />
                                </div>
                                <div>
                                    <label htmlFor="pw-new" className="label">Нова парола</label>
                                    <input
                                        id="pw-new"
                                        type="password"
                                        autoComplete="new-password"
                                        className="input"
                                        value={newPassword}
                                        onChange={(e) => setNewPassword(e.target.value)}
                                    />
                                    <p className="hint mt-1.5">Поне {MIN_LENGTH} символа.</p>
                                </div>
                                <div>
                                    <label htmlFor="pw-confirm" className="label">Повтори новата парола</label>
                                    <input
                                        id="pw-confirm"
                                        type="password"
                                        autoComplete="new-password"
                                        className="input"
                                        value={confirm}
                                        onChange={(e) => setConfirm(e.target.value)}
                                    />
                                </div>

                                {error && (
                                    <div role="alert" className="alert alert-danger">
                                        <CircleAlert size={16} aria-hidden="true" />
                                        <span>{error}</span>
                                    </div>
                                )}

                                <div className="flex justify-end gap-2 border-t border-line pt-5">
                                    <button type="button" onClick={close} className="btn btn-ghost">Отказ</button>
                                    <button
                                        type="submit"
                                        disabled={busy || !oldPassword || !newPassword || !confirm}
                                        className="btn btn-primary"
                                    >
                                        {busy ? 'Сменяне...' : 'Смени паролата'}
                                    </button>
                                </div>
                            </form>
                        )}
                    </div>
                </div>
            )}
        </Modal>
    );
}
