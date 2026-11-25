# Privacy Policy — VoiceForge Studio

**VoiceForge Studio** is a 100% client-side, local-first voice cloning and narration studio.

## Core Privacy Commitments

1. **Zero Server-Side Audio or Script Processing**
   - All reference audio decoding, preprocessing, speaker embedding extraction, speech synthesis, audio mastering, and WAV/MP3 export happen exclusively in your web browser on your device.
   - Your voice recordings, voice profiles, speaker embeddings, scripts, and generated audio are **never uploaded** to any VoiceForge Studio server or third-party inference API.

2. **Zero Analytics, Telemetry, or Tracking**
   - VoiceForge Studio contains **no** analytics SDKs, telemetry beacons, crash-reporting uploads, tracking pixels, cookies, or user fingerprinting.

3. **Local Persistence Only**
   - Projects, cached voice profiles, and downloaded AI model weights are stored locally in your browser's IndexedDB and Cache / OPFS storage.
   - You can inspect, export, or delete all locally stored voice profiles, projects, and cached model files at any time from within your browser or application storage controls.

4. **Model Downloads**
   - When you choose to download an AI model, your browser fetches the model artifacts directly from the pinned model repository (e.g., Hugging Face) specified in the local model manifest, or from locally hosted model files. No user audio or text is ever sent during model downloads.

5. **Authorized-Use Confirmation Notice**
   - VoiceForge Studio provides an in-app authorized-use confirmation checkbox before encoding or using a voice profile.
   - **Important**: Because VoiceForge Studio operates entirely offline/client-side without accounts or server verification, a client-side checkbox is a user attestation record stored locally—it is **not** independently verified consent. You are solely responsible for ensuring you have legal rights and explicit authorization to clone and use any voice.
