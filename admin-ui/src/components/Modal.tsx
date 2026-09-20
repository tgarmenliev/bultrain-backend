import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Long enough to read as an exit, short enough to never feel like waiting.
const EXIT_MS = 150;

interface Props {
    label: string;
    onClose: () => void;
    /** Receives `close`, which plays the exit animation and then calls onClose. */
    children: (close: () => void) => ReactNode;
}

export default function Modal({ label, onClose, children }: Props) {
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

    return createPortal(
        <div
            className="modal-backdrop"
            data-closing={closing ? '' : undefined}
            role="dialog"
            aria-modal="true"
            aria-label={label}
        >
            {children(close)}
        </div>,
        document.body
    );
}
