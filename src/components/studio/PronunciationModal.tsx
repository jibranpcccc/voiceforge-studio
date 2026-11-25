import { useState } from 'react';
import { BookOpen, Edit3, Plus, Trash2, X } from 'lucide-react';
import {
  applyPronunciationRules,
  validatePronunciationRule,
} from '../../services/pronunciation';
import type { PronunciationRule } from '../../types';

export interface PronunciationModalProps {
  open: boolean;
  onClose: () => void;
  rules: PronunciationRule[];
  onSaveRule: (
    rule: Omit<PronunciationRule, 'id'> & { id?: string }
  ) => Promise<PronunciationRule>;
  onToggleRule: (id: string) => Promise<void>;
  onDeleteRule: (id: string) => Promise<void>;
}

export function PronunciationModal({
  open,
  onClose,
  rules,
  onSaveRule,
  onToggleRule,
  onDeleteRule,
}: PronunciationModalProps) {
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [pattern, setPattern] = useState('');
  const [replacement, setReplacement] = useState('');
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [testPhrase, setTestPhrase] = useState(
    'ONNX Runtime and NVIDIA CUDA work with Dr. Chen in v2.1.'
  );

  if (!open) return null;

  const resetForm = () => {
    setEditingId(undefined);
    setPattern('');
    setReplacement('');
    setIsRegex(false);
    setCaseSensitive(false);
    setNote('');
    setError(null);
  };

  const startEdit = (rule: PronunciationRule) => {
    setEditingId(rule.id);
    setPattern(rule.pattern);
    setReplacement(rule.replacement);
    setIsRegex(rule.isRegex);
    setCaseSensitive(rule.caseSensitive);
    setNote(rule.note ?? '');
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const validation = validatePronunciationRule({
      pattern,
      replacement,
      isRegex,
      caseSensitive,
    });
    if (!validation.valid) {
      setError(validation.error ?? 'Invalid rule.');
      return;
    }

    try {
      await onSaveRule({
        ...(editingId ? { id: editingId } : {}),
        pattern,
        replacement,
        isRegex,
        caseSensitive,
        enabled: true,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const previewOutput = applyPronunciationRules(testPhrase, rules);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface)] shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--vf-border-subtle)]">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-[var(--vf-accent)]" />
            <div>
              <h2 className="text-base font-semibold text-[var(--vf-text)]">
                Pronunciation Dictionary
              </h2>
              <p className="text-xs text-[var(--vf-text-muted)]">
                Non-destructive phonetic &amp; acronym substitutions stored locally in IndexedDB.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:bg-[var(--vf-surface-muted)] transition"
            aria-label="Close pronunciation modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Add / Edit Rule Form */}
          <form
            onSubmit={handleSubmit}
            className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-bg)] p-4 space-y-3"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[var(--vf-text-muted)] mb-1">
                  Match Word / Pattern
                </label>
                <input
                  type="text"
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  placeholder="e.g. ONNX or \\bv(\\d+)\\.(\\d+)\\b"
                  className="w-full rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface)] px-3 py-1.5 text-xs text-[var(--vf-text)] placeholder:text-[var(--vf-text-subtle)] focus:border-[var(--vf-accent)] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--vf-text-muted)] mb-1">
                  Spoken Replacement
                </label>
                <input
                  type="text"
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  placeholder="e.g. on-icks"
                  className="w-full rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface)] px-3 py-1.5 text-xs text-[var(--vf-text)] placeholder:text-[var(--vf-text-subtle)] focus:border-[var(--vf-accent)] focus:outline-none"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-4 text-xs text-[var(--vf-text-muted)]">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isRegex}
                    onChange={(e) => setIsRegex(e.target.checked)}
                    className="accent-[var(--vf-accent)]"
                  />
                  Regex
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={caseSensitive}
                    onChange={(e) => setCaseSensitive(e.target.checked)}
                    className="accent-[var(--vf-accent)]"
                  />
                  Case-sensitive
                </label>
              </div>

              <div className="flex items-center gap-2">
                {editingId && (
                  <button
                    type="button"
                    onClick={resetForm}
                    className="px-3 py-1.5 rounded-md text-xs border border-[var(--vf-border)] bg-[var(--vf-surface)] text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] transition"
                  >
                    Cancel Edit
                  </button>
                )}
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--vf-accent)] text-white hover:bg-[var(--vf-accent-hover)] transition"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {editingId ? 'Update Rule' : 'Add Rule'}
                </button>
              </div>
            </div>

            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note (e.g. brand pronunciation)"
              className="w-full rounded-md border border-[var(--vf-border)] bg-[var(--vf-surface)] px-3 py-1.5 text-xs text-[var(--vf-text)] placeholder:text-[var(--vf-text-subtle)] focus:border-[var(--vf-accent)] focus:outline-none"
            />

            {error && <p className="text-xs text-[var(--vf-danger)]">{error}</p>}
          </form>

          {/* Rule List */}
          <div className="space-y-2">
            <div className="text-xs font-semibold text-[var(--vf-text)] tabular-nums">
              Saved Rules ({rules.length})
            </div>
            {rules.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--vf-border)] p-6 text-center text-xs text-[var(--vf-text-muted)]">
                No custom pronunciation rules saved yet.
              </div>
            ) : (
              <div className="divide-y divide-[var(--vf-border-subtle)] rounded-lg border border-[var(--vf-border)]">
                {rules.map((rule) => (
                  <div
                    key={rule.id}
                    className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs"
                  >
                    <label className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={() => void onToggleRule(rule.id)}
                        className="accent-[var(--vf-accent)]"
                      />
                      <div className={`min-w-0 ${rule.enabled ? '' : 'opacity-50 line-through'}`}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <code className="px-1.5 py-0.5 rounded-sm bg-[var(--vf-surface-muted)] text-[var(--vf-text)] font-mono">
                            {rule.pattern}
                          </code>
                          <span className="text-[var(--vf-text-subtle)]">&rarr;</span>
                          <span className="font-medium text-[var(--vf-accent)]">
                            {rule.replacement || '(empty)'}
                          </span>
                          {rule.isRegex && (
                            <span className="px-1.5 py-0.5 rounded-sm bg-[var(--vf-accent)]/12 text-[var(--vf-accent)] text-[10px] font-mono">
                              regex
                            </span>
                          )}
                          {rule.caseSensitive && (
                            <span className="px-1.5 py-0.5 rounded-sm bg-[var(--vf-surface-muted)] text-[var(--vf-text-muted)] text-[10px] font-mono">
                              case
                            </span>
                          )}
                        </div>
                        {rule.note && (
                          <div className="text-[11px] text-[var(--vf-text-muted)] mt-0.5">
                            {rule.note}
                          </div>
                        )}
                      </div>
                    </label>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => startEdit(rule)}
                        className="p-1.5 rounded-md text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:bg-[var(--vf-surface-muted)] transition"
                        title="Edit rule"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void onDeleteRule(rule.id)}
                        className="p-1.5 rounded-md text-[var(--vf-text-muted)] hover:text-[var(--vf-danger)] hover:bg-[var(--vf-danger)]/10 transition"
                        title="Delete rule"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Live Test Preview */}
          <div className="rounded-lg border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] p-3.5 space-y-2">
            <label className="block text-xs font-semibold text-[var(--vf-text)]">
              Live Rule Tester
            </label>
            <input
              type="text"
              value={testPhrase}
              onChange={(e) => setTestPhrase(e.target.value)}
              className="w-full rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-3 py-1.5 text-xs text-[var(--vf-text)] focus:border-[var(--vf-accent)] focus:outline-none"
            />
            <div className="text-xs text-[var(--vf-text)] bg-[var(--vf-bg)] border border-[var(--vf-border-subtle)] rounded-md px-3 py-2">
              <span className="text-[10px] uppercase tracking-wider text-[var(--vf-text-subtle)] block mb-0.5">
                Normalized Synthesis Input
              </span>
              {previewOutput}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
