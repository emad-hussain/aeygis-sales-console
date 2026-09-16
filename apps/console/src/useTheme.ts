import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Light/dark theme state.
 *
 * There are THREE states, not two, and the third is the default:
 *
 *   choice === null    follow the operating system (nothing stamped on <html>,
 *                      so the CSS `prefers-color-scheme` block decides)
 *   choice === 'light' explicit light, even on a dark OS
 *   choice === 'dark'  explicit dark, even on a light OS
 *
 * Two behaviours worth knowing about:
 *
 *  1. Choosing the theme the OS is already on CLEARS the stored choice rather
 *     than pinning it. So toggling back to where you started leaves the
 *     console following the system again, and there is no separate "reset to
 *     system" control to explain. Divergence is the only thing worth storing.
 *
 *  2. While following the system, an OS theme change is picked up live — the
 *     media query is subscribed, not just read once at mount.
 *
 * The initial stamp is NOT done here. A `useEffect` runs after first paint, so
 * an explicit choice would flash the other theme first; the inline script in
 * index.html applies it before paint instead. This hook and that script share
 * STORAGE_KEY, and they must keep sharing it.
 */

export const STORAGE_KEY = 'aeygis-console-theme';

export type Theme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The ground colour per theme, mirrored from brand.css for <meta theme-color>. */
const GROUND: Record<Theme, string> = {
  light: '#f6f5f2',
  dark: '#131312',
};

/** localStorage throws outright in some privacy modes — never let that be fatal. */
function readStored(): Theme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

export interface ThemeState {
  /** What is actually on screen. */
  readonly theme: Theme;
  /** null when following the OS. */
  readonly choice: Theme | null;
  readonly toggle: () => void;
}

export function useTheme(): ThemeState {
  const [choice, setChoice] = useState<Theme | null>(readStored);
  const [system, setSystem] = useState<Theme>(systemTheme);

  // Track the OS preference for as long as we are following it. Subscribed
  // unconditionally: cheap, and it keeps `system` correct for the moment the
  // user clears their choice.
  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => setSystem(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const theme: Theme = choice ?? system;

  useEffect(() => {
    const root = document.documentElement;
    if (choice === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);

    // Mobile browser chrome blends with the app instead of staying light.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta !== null) meta.setAttribute('content', GROUND[theme]);
  }, [choice, theme]);

  // Cleared on unmount so the class can never be left stuck on <html>.
  const flipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flipTimer.current !== null) clearTimeout(flipTimer.current);
    },
    [],
  );

  const toggle = useCallback(() => {
    // Arms the one-shot colour transition in brand.css. Re-arming mid-flip
    // restarts the window rather than stacking timers.
    const root = document.documentElement;
    root.classList.add('theme-changing');
    if (flipTimer.current !== null) clearTimeout(flipTimer.current);
    flipTimer.current = setTimeout(() => {
      root.classList.remove('theme-changing');
      flipTimer.current = null;
    }, 260);

    setChoice((current) => {
      const next: Theme = (current ?? systemTheme()) === 'dark' ? 'light' : 'dark';
      // Landing back on what the OS says means "follow the OS" again.
      const stored = next === systemTheme() ? null : next;
      try {
        if (stored === null) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, stored);
      } catch {
        /* Storage unavailable — the choice still applies for this session. */
      }
      return stored;
    });
  }, []);

  return { theme, choice, toggle };
}
