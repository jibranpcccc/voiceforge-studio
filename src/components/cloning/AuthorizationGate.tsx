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
      className={`rounded-lg border p-4 space-y-3.5 transition-colors ${
        confirmed
          ? 'border-[var(--vf-success)]/45 bg-[var(--vf-success)]/5'
          : 'border-[var(--vf-warning)]/45 bg-[var(--vf-warning)]/5'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[var(--vf-border-subtle)]">
        <div className="flex items-center gap-2">
          {confirmed ? (
            <ShieldCheck className="h-4 w-4 text-[var(--vf-success)]" />
          ) : (
            <Lock className="h-4 w-4 text-[var(--vf-warning)]" />
          )}
          <h3 className="text-sm font-semibold text-[var(--vf-text)]">
            Authorized Voice Use Confirmation
          </h3>
        </div>
        <span
          className={`rounded-sm px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider font-semibold border ${
            confirmed
              ? 'bg-[var(--vf-success)]/15 text-[var(--vf-success)] border-[var(--vf-success)]/35'
              : 'bg-[var(--vf-warning)]/15 text-[var(--vf-warning)] border-[var(--vf-warning)]/35'
          }`}
        >
          {confirmed ? 'Confirmed (Self-Attested)' : 'Required Before Encoding'}
        </span>
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor="auth-source-basis"
          className="block text-[11px] font-mono uppercase tracking-wider font-medium text-[var(--vf-text-muted)]"
        >
          Authorization Basis
        </label>
        <select
          id="auth-source-basis"
          value={sourceBasis}
          disabled={disabled}
          onChange={(e) => onSourceBasisChange(e.target.value as AuthorizationSourceBasis)}
          className="w-full rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] px-3 py-2 text-xs text-[var(--vf-text)] focus:outline-none focus:border-[var(--vf-accent)] focus:ring-1 focus:ring-[var(--vf-accent)]/40"
        >
          {SOURCE_BASIS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label} — {opt.detail}
            </option>
          ))}
        </select>
      </div>

      <label className="flex items-start gap-2.5 cursor-pointer select-none rounded-md border border-[var(--vf-border)] bg-[var(--vf-bg)] p-3 hover:border-[var(--vf-text-subtle)] transition-colors">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled}
          onChange={(e) => onConfirmedChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-[var(--vf-border)] accent-[var(--vf-accent)]"
        />
        <span className="text-xs leading-relaxed text-[var(--vf-text)]">
          {ATTESTATION_TEXT}
        </span>
      </label>

      <div className="flex items-start gap-2 rounded-md border border-[var(--vf-border-subtle)] bg-[var(--vf-surface-elevated)] p-2.5 text-[11px] text-[var(--vf-text-muted)]">
        {confirmed ? (
          <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-[var(--vf-text-subtle)]" />
        ) : (
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-[var(--vf-warning)]" />
        )}
        <p>
          <strong className="text-[var(--vf-text)]">Client-side self-attestation notice:</strong> Checking this box records a
          local self-attestation (<code className="font-mono">client-self-attested</code>) in
          your browser&apos;s IndexedDB profile. It is <strong className="text-[var(--vf-text)]">not</strong> independently
          verified and does not replace legal consent or licensing agreements.
        </p>
      </div>
    </div>
  );
}

export const VOICE_AUTHORIZATION_ATTESTATION_TEXT = ATTESTATION_TEXT;
