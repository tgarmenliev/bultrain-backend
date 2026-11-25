import { useCallback, useSyncExternalStore } from 'react';

/**
 * The two layouts of the panel. Must match the `desktop` variant and the media
 * queries in index.css. A phone held sideways is wide but short, so width alone
 * would hand it the sidebar layout with half of it off the screen.
 */
export const DESKTOP = '(min-width: 48rem) and (min-height: 32rem)';
/** Narrow enough that a table has to become a list. */
export const NARROW = '(max-width: 39.99rem)';
/** A finger rather than a mouse. */
export const TOUCH = '(pointer: coarse)';

export function useMediaQuery(query: string): boolean {
    const subscribe = useCallback((onChange: () => void) => {
        const mq = window.matchMedia(query);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, [query]);
    return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}
