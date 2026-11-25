import { create } from 'zustand';
import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface ToastItem {
  id: string;
  title: string;
  message?: string;
  tone: ToastTone;
  durationMs: number;
}

interface ToastStoreState {
  toasts: ToastItem[];
  push: (input: Omit<ToastItem, 'id' | 'durationMs'> & { durationMs?: number }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useToastStore = create<ToastStoreState>((set) => ({
  toasts: [],
  push: (input) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const durationMs = input.durationMs ?? 4500;
    const item: ToastItem = {
      id,
      title: input.title,
      message: input.message,
      tone: input.tone,
      durationMs,
    };
    set((state) => ({ toasts: [...state.toasts.slice(-4), item] }));
    if (durationMs > 0 && typeof window !== 'undefined') {
      window.setTimeout(() => {
        set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
      }, durationMs);
    }
    return id;
  },
  dismiss: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
  clear: () => set({ toasts: [] }),
}));

export const toast = {
  info: (title: string, message?: string) =>
    useToastStore.getState().push({ title, message, tone: 'info' }),
  success: (title: string, message?: string) =>
    useToastStore.getState().push({ title, message, tone: 'success' }),
  warning: (title: string, message?: string) =>
    useToastStore.getState().push({ title, message, tone: 'warning' }),
  error: (title: string, message?: string) =>
    useToastStore.getState().push({ title, message, tone: 'error', durationMs: 6500 }),
};

const TONE_STYLES: Record<
  ToastTone,
  { border: string; iconClass: string; Icon: typeof Info }
> = {
  info: {
    border: 'border-l-[var(--vf-accent)]',
    iconClass: 'text-[var(--vf-accent)]',
    Icon: Info,
  },
  success: {
    border: 'border-l-[var(--vf-success)]',
    iconClass: 'text-[var(--vf-success)]',
    Icon: CheckCircle2,
  },
  warning: {
    border: 'border-l-[var(--vf-warning)]',
    iconClass: 'text-[var(--vf-warning)]',
    Icon: TriangleAlert,
  },
  error: {
    border: 'border-l-[var(--vf-danger)]',
    iconClass: 'text-[var(--vf-danger)]',
    Icon: AlertCircle,
  },
};

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-full max-w-sm pointer-events-none px-4 sm:px-0"
      aria-live="polite"
      aria-label="Notifications"
    >
      {toasts.map((item) => {
        const style = TONE_STYLES[item.tone];
        const Icon = style.Icon;
        return (
          <div
            key={item.id}
            className={`pointer-events-auto flex items-start gap-3 rounded-lg border border-[var(--vf-border)] border-l-2 ${style.border} bg-[var(--vf-surface)]/95 backdrop-blur-sm px-3.5 py-2.5 shadow-xl text-xs text-[var(--vf-text)]`}
            role="status"
          >
            <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${style.iconClass}`} />
            <div className="flex-1 min-w-0">
              <p className="font-semibold leading-snug">{item.title}</p>
              {item.message && (
                <p className="text-[11px] text-[var(--vf-text-muted)] mt-0.5 break-words">
                  {item.message}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              className="rounded-md p-1 text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:bg-[var(--vf-surface-muted)] cursor-pointer"
              aria-label="Dismiss notification"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
