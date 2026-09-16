import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Transient confirmations, docked bottom-right.
 *
 * Only for outcomes that are BRIEF and need no follow-up — "Changes saved".
 * Anything the reader has to act on, quote back, or copy (a proposal id, an
 * authorization refusal, an exec sign-off warning) stays as an inline notice
 * next to the control that produced it, because a toast that disappears is a
 * terrible place to put a fact someone needs.
 *
 * Errors get a toast AND stay inline for the same reason.
 */

export type ToastKind = 'ok' | 'bad';

interface ToastItem {
  readonly id: number;
  readonly kind: ToastKind;
  readonly text: string;
}

type PushToast = (kind: ToastKind, text: string) => void;

/** No-op default so a component rendered outside the provider (a test, a
 *  storybook) does not explode — it just does not toast. */
const ToastContext = createContext<PushToast>(() => {});

export function useToast(): PushToast {
  return useContext(ToastContext);
}

const DISMISS_AFTER_MS = 5000;

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [items, setItems] = useState<readonly ToastItem[]>([]);
  const nextId = useRef(1);
  // Every pending auto-dismiss, so unmounting cannot leave a timer running
  // against a dead setState.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback<PushToast>(
    (kind, text) => {
      const id = nextId.current;
      nextId.current += 1;
      // Cap the stack. Three is already more than anyone reads; beyond that
      // the dock starts covering the app it is reporting on.
      setItems((prev) => [...prev.slice(-2), { id, kind, text }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DISMISS_AFTER_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      {/* aria-live so the confirmation reaches a screen reader too — the
          visual toast is otherwise the only signal that a save landed. */}
      <div className="toast-dock" role="status" aria-live="polite">
        {items.map((t) => (
          <div className={t.kind === 'bad' ? 'toast toast-bad' : 'toast'} key={t.id}>
            <span className="toast-mark" aria-hidden="true">
              {t.kind === 'bad' ? '!' : '✓'}
            </span>
            <span>{t.text}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              &times;
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
