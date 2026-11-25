import { useCallback, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'bultrain-admin-theme';
// --surface in index.css (and in index.html, before the first paint)
const BAR_LIGHT = '#ffffff';
const BAR_DARK = '#0c1b2e';

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function apply(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);

  // The two theme-color tags answer the system setting; a manual choice overrides both.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    const dark = pref === 'system' ? meta.media.includes('dark') : pref === 'dark';
    meta.content = dark ? BAR_DARK : BAR_LIGHT;
  });
}

let animTimer: number | undefined;

export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>(readPref);

  const setPref = useCallback((next: ThemePref) => {
    // Cross-fade colours for a moment, then drop the rule again so ordinary
    // interactions keep their own, snappier transitions.
    const root = document.documentElement;
    root.classList.add('theme-anim');
    window.clearTimeout(animTimer);
    animTimer = window.setTimeout(() => root.classList.remove('theme-anim'), 320);

    apply(next);
    try {
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* storage blocked — the choice still applies for this session */
    }
    setPrefState(next);
  }, []);

  return { pref, setPref };
}
