import { AlertTriangle, Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { AuthorizedUseConfirmation } from '../../types';

export type AuthorizationSourceBasis = AuthorizedUseConfirmation['sourceBasis'];

export interface AuthorizationGateProps {
  confirmed: boolean;
  sourceBasis: AuthorizationSourceBasis;
  onConfirmedChange: (confirmed: boolean) => void;
  onSourceBasisChange: (basis: AuthorizationSourceBasis) => void;
  disabled?: boolean;
}

const SOURCE_BASIS_OPTIONS: Array<{
  value: AuthorizationSourceBasis;
  label: string;
  detail: string;
}> = [
  {
    value: 'self',
    label: 'My own voice',
    detail: 'I am cloning a recording of my own speaking voice.',
  },
  {
    value: 'written-consent',
    label: 'Written consent from speaker',
    detail: 'I hold explicit, documented consent from the voice speaker for this use.',
  },
  {
    value: 'licensed-talent',
    label: 'Licensed voice talent',
    detail: 'I have a valid commercial or personal voice license covering AI synthesis.',
  },
  {
    value: 'synthetic-character',
    label: 'Synthetic / non-identifying character',
    detail: 'The reference audio is synthetic or does not impersonate a real person.',
  },
  {
    value: 'other',
    label: 'Other authorized basis',
    detail: 'Another lawful authorization applies under applicable regulations.',
  },
];

const ATTESTATION_TEXT =
  'I confirm that I own or hold explicit legal authorization to use the selected reference voice audio for local AI voice cloning and speech synthesis, and that I will not use generated outputs for impersonation, fraud, or non-consensual deception.';

export function AuthorizationGate({
  confirmed,
  sourceBasis,
  onConfirmedChange,
  onSourceBasisChange,
  disabled = false,
}: AuthorizationGateProps) {
  return (
    <div
      className={`rounded-xl border p-4 space-y-3.5 transition-colors ${
        confirmed
          ? 'border-emerald-500/40 bg-emerald-500/5'
          : 'border-amber-500/40 bg-amber-500/5'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {confirmed ? (
            <ShieldCheck className="h-4 w-4 text-emerald-500" />
          ) : (
            <Lock className="h-4 w-4 text-amber-500" />
          )}
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Authorized Voice Use Confirmation
          </h3>
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold border ${
            confirmed
              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30'
              : 'bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30'
          }`}
        >
          {confirmed ? 'Confirmed (Self-Attested)' : 'Required Before Encoding'}
        </span>
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor="auth-source-basis"
          className="block text-xs font-medium text-slate-700 dark:text-slate-300"
        >
          Authorization Basis
        </label>
        <select
          id="auth-source-basis"
          value={sourceBasis}
          disabled={disabled}
          onChange={(e) => onSourceBasisChange(e.target.value as AuthorizationSourceBasis)}
          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0B0D12] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#7C5CFF]"
        >
          {SOURCE_BASIS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label} — {opt.detail}
            </option>
          ))}
        </select>
      </div>

      <label className="flex items-start gap-2.5 cursor-pointer select-none rounded-lg border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-[#0B0D12]/70 p-3">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled}
          onChange={(e) => onConfirmedChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-400 dark:border-slate-600 text-[#7C5CFF] focus:ring-[#7C5CFF]"
        />
        <span className="text-xs leading-relaxed text-slate-700 dark:text-slate-200">
          {ATTESTATION_TEXT}
        </span>
      </label>

      <div className="flex items-start gap-2 rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-100/80 dark:bg-[#0B0D12]/80 p-2.5 text-[11px] text-slate-600 dark:text-slate-400">
        {confirmed ? (
          <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-slate-500" />
        ) : (
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />
        )}
        <p>
          <strong>Client-side self-attestation notice:</strong> Checking this box records a
          local self-attestation (<code className="font-mono">client-self-attested</code>) in
          your browser&apos;s IndexedDB profile. It is <strong>not</strong> independently
          verified and does not replace legal consent or licensing agreements.
        </p>
      </div>
    </div>
  );
}

export const VOICE_AUTHORIZATION_ATTESTATION_TEXT = ATTESTATION_TEXT;
