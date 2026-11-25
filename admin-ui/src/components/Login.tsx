import { useState } from 'react';
import { CircleAlert } from 'lucide-react';
import ThemeToggle from './ThemeToggle';

// The name (never the password) is remembered on this computer, so signing in is one field.
const USERNAME_KEY = 'bultrain-admin-username';
const savedUsername = () => {
    try { return localStorage.getItem(USERNAME_KEY) ?? ''; } catch { return ''; }
};
const rememberUsername = (name: string) => {
    try {
        if (name) localStorage.setItem(USERNAME_KEY, name); else localStorage.removeItem(USERNAME_KEY);
    } catch { /* private window: nothing to remember it in */ }
};

export default function Login({ onLoginSuccess }: { onLoginSuccess: () => void }) {
    const [username, setUsername] = useState(savedUsername);
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setLoading(true);

        try {
            // A username means an account login (authors); empty falls back to the
            // legacy admin main-password login.
            const body = username.trim()
                ? { username: username.trim(), password }
                : { password };
            const response = await fetch('/api/admin/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Неуспешен вход');
            }

            // Success - cookie is set automatically by the browser due to HttpOnly
            rememberUsername(username.trim());
            onLoginSuccess();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="relative flex min-h-dvh items-center justify-center px-4 pb-8 pt-20">
            <div className="absolute right-4 top-[calc(1rem+var(--safe-top))]"><ThemeToggle /></div>

            <div className="w-full max-w-sm">
                <div className="mb-8 flex flex-col items-center text-center">
                    <img src={`${import.meta.env.BASE_URL}logo.png`} alt="BulTrain" className="h-auto w-24" />
                    <h1 className="page-title mt-5">Админ панел</h1>
                    <p className="page-sub">Въведете данните си за достъп.</p>
                </div>

                <form onSubmit={handleSubmit} className="card card-pad space-y-4">
                    <div>
                        <label htmlFor="username" className="label">Потребител</label>
                        <input
                            id="username"
                            type="text"
                            autoComplete="username"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            className="input"
                        />
                    </div>
                    <div>
                        <label htmlFor="password" className="label">Парола</label>
                        <input
                            id="password"
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="input"
                            required
                        />
                    </div>

                    {error && (
                        <div role="alert" className="alert alert-danger">
                            <CircleAlert size={16} aria-hidden="true" />
                            <span>{error}</span>
                        </div>
                    )}

                    <button type="submit" disabled={loading} className="btn btn-primary w-full">
                        {loading ? 'Удостоверяване...' : 'Влез в профила'}
                    </button>
                </form>
            </div>
        </div>
    );
}
