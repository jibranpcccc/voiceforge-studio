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
      className={`rounded-xl border transition-colors ${
        isDragging
          ? 'border-[#7C5CFF] bg-[#7C5CFF]/5'
          : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121622]'
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={onDrop}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-slate-200 dark:border-slate-800/80">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-[#7C5CFF]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
            Narration Script
          </span>
          {lastDraftSavedAt && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-300"
              title={`Last autosaved at ${new Date(lastDraftSavedAt).toLocaleString()}`}
            >
              <CheckCircle2 className="w-3 h-3" />
              Autosaved {new Date(lastDraftSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo || disabled}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition"
            title="Undo script edit"
          >
            <Undo2 className="w-3.5 h-3.5" />
            Undo
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedo || disabled}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition"
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
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition"
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
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 disabled:opacity-40 transition"
              title="Clear script"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {importError && (
        <div className="px-4 py-2 text-xs text-rose-600 dark:text-rose-300 bg-rose-500/10 border-b border-rose-500/20">
          {importError}
        </div>
      )}

      {/* Textarea */}
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={scriptText}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={14}
          placeholder="Write or paste your narration script here, or drag and drop a .txt file...&#10;&#10;Separate paragraphs with blank lines for natural pacing and independent paragraph regeneration."
          className="w-full min-h-[300px] resize-y bg-transparent p-4 text-sm leading-relaxed text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none disabled:opacity-60"
        />
        {isDragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#7C5CFF]/15 backdrop-blur-[1px] pointer-events-none">
            <div className="rounded-xl border border-[#7C5CFF] bg-white dark:bg-[#121622] px-5 py-3 text-sm font-medium text-[#7C5CFF] shadow-lg">
              Drop .TXT file to load script
            </div>
          </div>
        )}
      </div>

      {/* Footer Telemetry */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-t border-slate-200 dark:border-slate-800/80 text-xs text-slate-500 dark:text-slate-400">
        <div className="flex flex-wrap items-center gap-4">
          <span>
            <strong className="text-slate-800 dark:text-slate-200">{counts.words.toLocaleString()}</strong> words
          </span>
          <span>
            <strong className="text-slate-800 dark:text-slate-200">{counts.chars.toLocaleString()}</strong> chars
          </span>
          <span>
            <strong className="text-slate-800 dark:text-slate-200">{counts.paragraphs}</strong> paragraphs
          </span>
        </div>
        <div className="inline-flex items-center gap-1.5" title="Estimated at ~150 words per minute">
          <Clock className="w-3.5 h-3.5 text-[#7C5CFF]" />
          <span>Est. duration (~150 WPM):</span>
          <strong className="text-slate-800 dark:text-slate-200">
            {formatDurationCompact(estDurationSec)}
          </strong>
        </div>
      </div>
    </div>
  );
}
