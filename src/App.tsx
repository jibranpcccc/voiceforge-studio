import { AudioWaveform, ShieldCheck } from 'lucide-react';

export function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
      <main className="max-w-xl w-full rounded-2xl border border-slate-800 bg-slate-900/70 p-8 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="h-10 w-10 rounded-xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center text-indigo-300">
            <AudioWaveform className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">VoiceForge Studio</h1>
            <p className="text-sm text-slate-400">100% Client-Side AI Voice Cloning &amp; Narration</p>
          </div>
        </div>
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 flex items-start gap-3 text-sm text-emerald-200">
          <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400 mt-0.5" />
          <p>
            Local-first studio scaffold initialized. All inference, audio mastering, and exports run
            exclusively in your browser with zero external uploads.
          </p>
        </div>
      </main>
    </div>
  );
}

export default App;
