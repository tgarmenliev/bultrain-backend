import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Long enough to read as an exit, short enough to never feel like waiting.
const EXIT_MS = 150;

interface Props {
    label: string;
    onClose: () => void;
    /** `top` keeps a form clear of the phone keyboard. */
    align?: 'top';
    /** Close on Escape or a tap outside. Only for dialogs with nothing to lose. */
    dismissable?: boolean;
    /** Receives `close`, which plays the exit animation and then calls onClose. */
    children: (close: () => void) => ReactNode;
}

export default function Modal({ label, onClose, align, dismissable, children }: Props) {
    const [closing, setClosing] = useState(false);

    // Always call the latest onClose, without restarting the exit timer when the
    // parent re-renders with a new function identity.
    const onCloseRef = useRef(onClose);
    useEffect(() => {
        onCloseRef.current = onClose;
    });

    useEffect(() => {
        if (!closing) return;
        const timer = window.setTimeout(() => onCloseRef.current(), EXIT_MS);
        return () => window.clearTimeout(timer);
    }, [closing]);

    const close = useCallback(() => setClosing(true), []);

    useEffect(() => {
        if (!dismissable) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [dismissable, close]);

    return createPortal(
        <div
            className="modal-backdrop"
            data-closing={closing ? '' : undefined}
            data-align={align}
            data-dismissable={dismissable ? '' : undefined}
            onClick={dismissable ? (e) => { if (e.target === e.currentTarget) close(); } : undefined}
            role="dialog"
            aria-modal="true"
            aria-label={label}
        >
            {children(close)}
        </div>,
        document.body
    );
}
