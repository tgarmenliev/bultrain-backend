import { useState } from 'react';

export default function Login({ onLoginSuccess }: { onLoginSuccess: () => void }) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setLoading(true);

        try {
            const response = await fetch('/api/admin/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ password }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Неуспешен вход');
            }

            // Success - cookie is set automatically by the browser due to HttpOnly
            onLoginSuccess();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center p-4 animate-in-fade">
            <div className="max-w-md w-full glass-card rounded-3xl p-10 space-y-8 relative overflow-hidden group">
                <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-indigo-500 via-cyan-500 to-indigo-500"></div>

                <div className="text-center space-y-3 relative z-10">
                    <h1 className="text-4xl font-black tracking-tight text-gradient-brand pb-1">
                        Админ Панел
                    </h1>
                    <p className="text-slate-400 text-sm font-medium">
                        Въведете главната парола за достъп до системата.
                    </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <label
                            htmlFor="password"
                            className="text-sm font-bold text-slate-300 uppercase tracking-wider"
                        >
                            Главна Парола
                        </label>
                        <input
                            id="password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="input-premium w-full text-lg tracking-widest text-center"
                            placeholder="••••••••••••"
                            required
                        />
                    </div>

                    {error && (
                        <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-center shadow-inner animate-in-fade">
                            <svg className="w-5 h-5 mr-3 flex-shrink-0 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            <p className="text-sm font-medium text-rose-400">
                                {error}
                            </p>
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={loading}
                        className="btn-glow w-full py-4 mt-4 text-lg disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {loading ? 'Удостоверяване...' : 'Влез в профила'}
                    </button>
                </form>
            </div>
        </div>
    );
}
