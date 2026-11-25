import { KeyRound, LogOut, X } from 'lucide-react';
import Modal from './Modal';
import ThemeToggle from './ThemeToggle';

/** What the sidebar's footer holds, for the phone layout. */
export default function MobileMenu({ username, onClose, onPassword, onLogout }: {
    username: string | null;
    onClose: () => void;
    onPassword: () => void;
    onLogout: () => void;
}) {
    return (
        <Modal label="Меню" onClose={onClose} dismissable>
            {(close) => (
                <div className="modal-panel max-w-sm">
                    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                        <p className="min-w-0 truncate text-base font-semibold">{username ?? 'Акаунт'}</p>
                        <button onClick={close} aria-label="Затвори" className="btn btn-ghost btn-icon">
                            <X size={18} strokeWidth={2} aria-hidden="true" />
                        </button>
                    </div>

                    <div className="modal-scroll space-y-3 p-4">
                        <div className="flex items-center justify-between gap-3">
                            <span className="font-medium">Тема</span>
                            <ThemeToggle />
                        </div>
                        <button onClick={onPassword} className="btn btn-secondary w-full justify-start">
                            <KeyRound size={17} strokeWidth={2} aria-hidden="true" />
                            Смяна на парола
                        </button>
                        <button onClick={onLogout} className="btn btn-danger w-full justify-start">
                            <LogOut size={17} strokeWidth={2} aria-hidden="true" />
                            Изход
                        </button>
                    </div>
                </div>
            )}
        </Modal>
    );
}
