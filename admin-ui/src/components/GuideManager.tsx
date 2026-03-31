import React, { useState, useEffect } from 'react';

export interface Topic {
    id: number;
    app_topic_id: number;
    language: 'bg' | 'en';
    title: string;
    subtitle: string | null;
    cover_image: string | null;
    sort_order: number;
}

export default function GuideManager() {
    const [topics, setTopics] = useState<Topic[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Modal State
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingTopic, setEditingTopic] = useState<Topic | null>(null);

    // Form State
    const [formData, setFormData] = useState<Partial<Topic>>({
        language: 'bg',
        app_topic_id: 0,
        title: '',
        subtitle: '',
        cover_image: '',
    });

    const fetchTopics = async () => {
        try {
            setLoading(true);
            const res = await fetch('/api/admin/guide');
            if (!res.ok) throw new Error('Грешка при зареждане на темите');
            const data = await res.json();
            setTopics(data);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchTopics();
    }, []);

    const handleOpenModal = (topic?: Topic) => {
        if (topic) {
            setEditingTopic(topic);
            setFormData({
                app_topic_id: topic.app_topic_id,
                language: topic.language,
                title: topic.title,
                subtitle: topic.subtitle || '',
                cover_image: topic.cover_image || '',
                sort_order: topic.sort_order, // Read-only or editable depending on backend
            });
        } else {
            setEditingTopic(null);
            setFormData({ language: 'bg', app_topic_id: 0, title: '', subtitle: '', cover_image: '' });
        }
        setIsModalOpen(true);
    };

    const handleCloseModal = () => {
        setIsModalOpen(false);
        setEditingTopic(null);
    };

    const handleDelete = async (id: number) => {
        if (!window.confirm('Сигурни ли сте, че искате да изтриете тази тема? Отмяна не е възможна.')) return;
        try {
            const res = await fetch(`/api/admin/guide/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Неуспешно изтриване на темата');
            setTopics((prev) => prev.filter((t) => t.id !== id));
        } catch (err: any) {
            alert(err.message);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            const isEditing = !!editingTopic;
            const url = isEditing ? `/api/admin/guide/${editingTopic.id}` : '/api/admin/guide';
            const method = isEditing ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData),
            });

            if (!res.ok) {
                const errorData = await res.json();
                throw new Error(errorData.error || 'Неуспешна заявка');
            }

            await fetchTopics();
            handleCloseModal();
        } catch (err: any) {
            alert(err.message);
        }
    };

    if (loading && topics.length === 0) {
        return <div className="p-12 text-center text-slate-400 animate-pulse font-medium tracking-wide">Зареждане на темите...</div>;
    }

    if (error) {
        return (
            <div className="p-8 m-4 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-center shadow-inner">
                <p className="text-sm font-medium text-rose-400">Грешка: {error}</p>
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-in-fade relative z-10" style={{ animationDelay: '0.2s' }}>
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-3xl font-bold text-gradient">Справочник - Теми</h2>
                    <p className="text-slate-400 text-sm mt-2">Управление на темите в справочника за мобилното приложение.</p>
                </div>
                <button
                    onClick={() => handleOpenModal()}
                    className="btn-glow"
                >
                    Добави нова тема
                </button>
            </div>

            <div className="glass-card rounded-2xl overflow-hidden shadow-2xl">
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm text-slate-300">
                        <thead className="bg-slate-950/80 backdrop-blur-md text-slate-400 border-b border-slate-800 uppercase text-xs tracking-wider">
                            <tr>
                                <th className="px-6 py-4 font-medium">ID (App)</th>
                                <th className="px-6 py-4 font-medium">Заглавие</th>
                                <th className="px-6 py-4 font-medium">Език</th>
                                <th className="px-6 py-4 font-medium">Подзаглавие</th>
                                <th className="px-6 py-4 font-medium sticky right-0 bg-slate-950/80 backdrop-blur-md text-right">Действия</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/50">
                            {topics.map((topic) => (
                                <tr key={topic.id} className="hover:bg-slate-800/40 transition-colors">
                                    <td className="px-6 py-4 font-black text-white font-mono text-base">{topic.app_topic_id}</td>
                                    <td className="px-6 py-4 font-bold text-white text-base">{topic.title}</td>
                                    <td className="px-6 py-4">
                                        <span className={`px-3 py-1 rounded-md text-xs font-bold border shadow-sm tracking-widest ${topic.language === 'bg'
                                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 shadow-emerald-500/10'
                                            : 'bg-orange-500/10 text-orange-400 border-orange-500/20 shadow-orange-500/10'
                                            }`}>
                                            {topic.language.toUpperCase()}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-slate-400 truncate max-w-[200px] font-medium">
                                        {topic.subtitle || '—'}
                                    </td>
                                    <td className="px-6 py-4 text-right sticky right-0 bg-slate-900/40 backdrop-blur-sm group-hover:bg-slate-800/60 transition-colors border-l border-slate-800/50">
                                        <div className="flex justify-end space-x-3">
                                            <button
                                                onClick={() => handleOpenModal(topic)}
                                                className="px-4 py-2 bg-slate-800/50 hover:bg-indigo-500/20 text-slate-300 hover:text-indigo-400 rounded-lg text-sm font-medium transition-all duration-300 border border-transparent hover:border-indigo-500/30"
                                            >
                                                Редактирай
                                            </button>
                                            <button
                                                onClick={() => handleDelete(topic.id)}
                                                className="px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 rounded-lg text-sm font-medium transition-all duration-300 border border-transparent hover:border-rose-500/30"
                                            >
                                                Изтрий
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {topics.length === 0 && (
                                <tr>
                                    <td colSpan={5} className="px-6 py-12 text-center text-slate-500 font-medium">
                                        Не са намерени теми. Създайте нова.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Modal Overlay */}
            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm animate-in-fade">
                    <div className="glass-card w-full max-w-xl max-h-[90vh] flex flex-col rounded-3xl overflow-hidden ring-1 ring-white/10 shadow-[0_0_50px_rgba(0,0,0,0.5)]">
                        <div className="px-8 py-6 border-b border-slate-800/50 flex justify-between items-center bg-slate-900/50">
                            <h3 className="text-2xl font-black text-white">
                                {editingTopic ? 'Редактирай тема' : 'Добави нова тема'}
                            </h3>
                            <button onClick={handleCloseModal} className="text-slate-500 hover:text-white transition-colors bg-slate-800/50 hover:bg-slate-700/50 p-2 rounded-full">
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>

                        <div className="overflow-y-auto max-h-[calc(90vh-[80px])] custom-scrollbar">
                            <form onSubmit={handleSubmit} className="p-8 space-y-6">
                                <div className="grid grid-cols-2 gap-6">
                                    <div className="space-y-2 text-left">
                                        <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Език</label>
                                        <select
                                            value={formData.language}
                                            onChange={(e) => setFormData({ ...formData, language: e.target.value as 'bg' | 'en' })}
                                            disabled={!!editingTopic} // Lock language on edit
                                            className="input-premium w-full !py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            <option value="bg">Български</option>
                                            <option value="en">Английски</option>
                                        </select>
                                    </div>
                                    <div className="space-y-2 text-left">
                                        <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">ID на тема (Приложение)</label>
                                        <input
                                            type="number"
                                            value={formData.app_topic_id}
                                            onChange={(e) => setFormData({ ...formData, app_topic_id: Number(e.target.value) })}
                                            disabled={!!editingTopic} // Lock app_topic_id on edit
                                            required
                                            className="input-premium w-full !py-2.5 disabled:opacity-50 disabled:cursor-not-allowed font-mono"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2 text-left">
                                    <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Заглавие</label>
                                    <input
                                        type="text"
                                        value={formData.title}
                                        onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                                        required
                                        className="input-premium w-full !py-2.5"
                                    />
                                </div>

                                <div className="space-y-2 text-left">
                                    <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Подзаглавие</label>
                                    <input
                                        type="text"
                                        value={formData.subtitle || ''}
                                        onChange={(e) => setFormData({ ...formData, subtitle: e.target.value })}
                                        className="input-premium w-full !py-2.5"
                                    />
                                </div>

                                <div className="space-y-2 text-left">
                                    <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Име на файл за корица</label>
                                    <input
                                        type="text"
                                        value={formData.cover_image || ''}
                                        onChange={(e) => setFormData({ ...formData, cover_image: e.target.value })}
                                        placeholder="напр. topic1.jpg"
                                        className="input-premium w-full !py-2.5"
                                    />
                                </div>

                                <div className="pt-6 mt-6 border-t border-slate-800/50 flex justify-end space-x-4">
                                    <button
                                        type="button"
                                        onClick={handleCloseModal}
                                        className="px-6 py-2.5 hover:bg-slate-800 text-slate-300 rounded-xl font-bold transition-all duration-300 border border-transparent hover:border-slate-700"
                                    >
                                        Отказ
                                    </button>
                                    <button
                                        type="submit"
                                        className="btn-glow px-8"
                                    >
                                        {editingTopic ? 'Запази промените' : 'Създай тема'}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
