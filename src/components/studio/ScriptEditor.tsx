import { useRef, useState, type DragEvent } from 'react';
import {
  CheckCircle2,
  Clock,
  FileText,
  Redo2,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react';
import {
  countWordsAndChars,
  estimateNarrationDurationSec,
} from '../../services/segmenter';
import { formatDurationCompact } from './studioHelpers';

export interface ScriptEditorProps {
  scriptText: string;
  onChange: (nextText: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  lastDraftSavedAt: string | null;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
  onClear?: () => void;
}

export function ScriptEditor({
  scriptText,
  onChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  lastDraftSavedAt,
  textareaRef,
  disabled = false,
  onClear,
}: ScriptEditorProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const counts = countWordsAndChars(scriptText);
  const estDurationSec = estimateNarrationDurationSec(scriptText, 150);

  const handleTxtFile = async (file: File) => {
    setImportError(null);
    if (!file.name.toLowerCase().endsWith('.txt') && !file.type.startsWith('text/')) {
      setImportError('Please select a plain text (.txt) file.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setImportError('Text file exceeds 5 MB limit.');
      return;
    }
    const text = await file.text();
    onChange(text);
  };

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    if (file) {
      await handleTxtFile(file);
    }
  };

  return (
    <div
      className={`rounded-lg border transition-colors ${
        isDragging
          ? 'border-[var(--vf-accent)] bg-[var(--vf-accent)]/5'
          : 'border-[var(--vf-border)] bg-[var(--vf-surface)]'
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={onDrop}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-[var(--vf-border-subtle)]">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-[var(--vf-accent)]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--vf-text-muted)]">
            Narration Script
          </span>
          {lastDraftSavedAt && (
            <span
              className="inline-flex items-center gap-1 rounded-md bg-[var(--vf-success)]/10 border border-[var(--vf-success)]/25 px-2 py-0.5 text-[11px] font-medium tabular-nums text-[var(--vf-success)]"
              title={`Last autosaved at ${new Date(lastDraftSavedAt).toLocaleString()}`}
            >
              <CheckCircle2 className="w-3 h-3" />
              Autosaved{' '}
              {new Date(lastDraftSavedAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo || disabled}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:border-[var(--vf-text-subtle)] disabled:opacity-40 disabled:cursor-not-allowed transition"
            title="Undo script edit"
          >
            <Undo2 className="w-3.5 h-3.5" />
            Undo
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedo || disabled}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:border-[var(--vf-text-subtle)] disabled:opacity-40 disabled:cursor-not-allowed transition"
            title="Redo script edit"
          >
            <Redo2 className="w-3.5 h-3.5" />
            Redo
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,text/plain"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                void handleTxtFile(file);
              }
              e.target.value = '';
            }}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border border-[var(--vf-border)] bg-[var(--vf-surface-elevated)] text-[var(--vf-text-muted)] hover:text-[var(--vf-text)] hover:border-[var(--vf-text-subtle)] disabled:opacity-40 transition"
            title="Import .TXT script file"
          >
            <Upload className="w-3.5 h-3.5" />
            Import TXT
          </button>

          {onClear && scriptText.length > 0 && (
            <button
              type="button"
              disabled={disabled}
              onClick={onClear}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-[var(--vf-danger)] hover:bg-[var(--vf-danger)]/10 disabled:opacity-40 transition"
              title="Clear script"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {importError && (
        <div className="px-4 py-2 text-xs text-[var(--vf-danger)] bg-[var(--vf-danger)]/10 border-b border-[var(--vf-danger)]/25">
          {importError}
        </div>
      )}

      {/* Textarea */}
      <div className="relative bg-[var(--vf-bg)]/40">
        <textarea
          ref={textareaRef}
          value={scriptText}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={14}
          placeholder="Write or paste your narration script here, or drag and drop a .txt file...&#10;&#10;Separate paragraphs with blank lines for natural pacing and independent paragraph regeneration."
          className="w-full min-h-[300px] resize-y bg-transparent p-4 text-sm leading-relaxed text-[var(--vf-text)] placeholder:text-[var(--vf-text-subtle)] focus:outline-none disabled:opacity-60"
        />
        {isDragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--vf-accent)]/12 backdrop-blur-[1px] pointer-events-none">
            <div className="rounded-lg border border-[var(--vf-accent)] bg-[var(--vf-surface)] px-5 py-3 text-sm font-medium text-[var(--vf-accent)] shadow-lg">
              Drop .TXT file to load script
            </div>
          </div>
        )}
      </div>

      {/* Footer Telemetry */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-t border-[var(--vf-border-subtle)] text-xs text-[var(--vf-text-muted)] tabular-nums">
        <div className="flex flex-wrap items-center gap-4">
          <span>
            <strong className="font-mono text-[var(--vf-text)]">
              {counts.words.toLocaleString()}
            </strong>{' '}
            words
          </span>
          <span>
            <strong className="font-mono text-[var(--vf-text)]">
              {counts.chars.toLocaleString()}
            </strong>{' '}
            chars
          </span>
          <span>
            <strong className="font-mono text-[var(--vf-text)]">{counts.paragraphs}</strong>{' '}
            paragraphs
          </span>
        </div>
        <div
          className="inline-flex items-center gap-1.5"
          title="Estimated at ~150 words per minute"
        >
          <Clock className="w-3.5 h-3.5 text-[var(--vf-accent)]" />
          <span>Est. duration (~150 WPM):</span>
          <strong className="font-mono text-[var(--vf-text)]">
            {formatDurationCompact(estDurationSec)}
          </strong>
        </div>
      </div>
    </div>
  );
}
