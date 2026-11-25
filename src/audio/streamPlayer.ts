/**
 * Ordered Web Audio streaming player for multi-chunk and parallel-worker synthesis.
 * Schedules incoming PCM frames gaplessly for the active chunkIndex while buffering
 * ahead-of-order frames from parallel workers until their turn in script order.
 */

interface BufferedChunkFrames {
  frames: Array<{ samples: Float32Array; sampleRate: number }>;
  finished: boolean;
  pauseAfterMs: number;
}

export class OrderedStreamAudioPlayer {
  private ctx: AudioContext | null = null;
  private currentChunkIndex = 0;
  private nextStartTime = 0;
  private readonly buffers = new Map<number, BufferedChunkFrames>();
  private readonly activeSources = new Set<AudioBufferSourceNode>();
  private disposed = false;
  private playing = false;

  constructor(existingContext?: AudioContext, startChunkIndex = 0) {
    this.currentChunkIndex = Math.max(0, startChunkIndex);
    if (existingContext) {
      this.ctx = existingContext;
    } else if (typeof AudioContext !== 'undefined') {
      this.ctx = new AudioContext();
    }
  }

  /** Must be called inside user-gesture handler to satisfy browser autoplay policy. */
  async prime(): Promise<void> {
    if (this.disposed || !this.ctx) return;
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => undefined);
    }
    this.nextStartTime = Math.max(this.nextStartTime, this.ctx.currentTime + 0.04);
  }

  pushChunk(chunkIndex: number, samples: Float32Array, sampleRate: number): void {
    if (this.disposed || !this.ctx || samples.length === 0) return;

    if (chunkIndex === this.currentChunkIndex) {
      this.scheduleFrame(samples, sampleRate);
      return;
    }

    if (chunkIndex < this.currentChunkIndex) {
      return;
    }

    let entry = this.buffers.get(chunkIndex);
    if (!entry) {
      entry = { frames: [], finished: false, pauseAfterMs: 250 };
      this.buffers.set(chunkIndex, entry);
    }
    entry.frames.push({ samples: new Float32Array(samples), sampleRate });
  }

  markChunkFinished(chunkIndex: number, pauseAfterMs = 250): void {
    if (this.disposed) return;

    if (chunkIndex === this.currentChunkIndex) {
      this.nextStartTime += Math.max(0, pauseAfterMs) / 1000;
      this.currentChunkIndex += 1;
      this.drainReadyChunks();
      return;
    }

    if (chunkIndex > this.currentChunkIndex) {
      let entry = this.buffers.get(chunkIndex);
      if (!entry) {
        entry = { frames: [], finished: true, pauseAfterMs };
        this.buffers.set(chunkIndex, entry);
      } else {
        entry.finished = true;
        entry.pauseAfterMs = pauseAfterMs;
      }
    }
  }

  isPlaying(): boolean {
    return this.playing && !this.disposed;
  }

  stop(): void {
    this.buffers.clear();
    this.currentChunkIndex = 0;
    this.playing = false;
    for (const src of this.activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Ignore already-stopped nodes.
      }
    }
    this.activeSources.clear();
    if (this.ctx) {
      this.nextStartTime = this.ctx.currentTime + 0.04;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') {
      await ctx.close().catch(() => undefined);
    }
  }

  private drainReadyChunks(): void {
    while (!this.disposed) {
      const entry = this.buffers.get(this.currentChunkIndex);
      if (!entry) break;
      for (const frame of entry.frames) {
        this.scheduleFrame(frame.samples, frame.sampleRate);
      }
      entry.frames.length = 0;
      if (!entry.finished) {
        break;
      }
      this.buffers.delete(this.currentChunkIndex);
      this.nextStartTime += Math.max(0, entry.pauseAfterMs) / 1000;
      this.currentChunkIndex += 1;
    }
  }

  private scheduleFrame(samples: Float32Array, sampleRate: number): void {
    if (this.disposed || !this.ctx || samples.length === 0) return;

    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => undefined);
    }

    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);

    const startAt = Math.max(this.ctx.currentTime + 0.03, this.nextStartTime);
    this.nextStartTime = startAt + buffer.duration;
    this.playing = true;
    this.activeSources.add(source);

    source.onended = () => {
      this.activeSources.delete(source);
      source.disconnect();
      if (this.activeSources.size === 0 && this.buffers.size === 0) {
        this.playing = false;
      }
    };

    source.start(startAt);
  }
}
