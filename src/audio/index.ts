export {
  AudioDecodeError,
  MAX_AUDIO_FILE_BYTES,
  MAX_VIDEO_FILE_BYTES,
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_AUDIO_MIME_TYPES,
  SUPPORTED_VIDEO_EXTENSIONS,
  SUPPORTED_VIDEO_MIME_TYPES,
  audioBufferToAudioBufferData,
  decodeAudioArrayBuffer,
  decodeAudioFile,
  decodeWavBuffer,
  downmixAudioBufferToMono,
  downmixToMono,
  extractAudioFromVideoFile,
  pcmToAudioBufferData,
  resampleAudioBufferData,
  resamplePcm,
  resampleWithOfflineAudioContext,
  validateAudioFile,
  validateVideoFile,
  type AudioDecodeErrorCode,
  type DecodeAudioOptions,
  type ExtractVideoAudioOptions,
} from './decoder';

export {
  analyzeReferenceAudio,
  type AnalyzeQualityOptions,
} from './qualityAnalyzer';

export {
  DEFAULT_PREPROCESSING_OPTIONS,
  preprocessReferenceAudio,
  type ReferencePreprocessingOptions,
} from './preprocessor';

export {
  MASTERING_PRESETS,
  applyTruePeakLimiterInPlace,
  masterAudio,
  masterNarrationChunks,
  measureTruePeakDb,
  reduceExcessiveSilenceInPcm,
  wsolaTimeStretch,
  type ChunkJoinOptions,
  type MasteringExtraOptions,
} from './mastering';

export {
  PROVENANCE_COMMENT_TAG,
  PROVENANCE_SOFTWARE_TAG,
  SRT_BOUNDARY_NOTE,
  encodeMp3,
  encodeWav16,
  encodeWav24,
  exportAudio,
  exportSegmentsZip,
  formatSrtTimestamp,
  generateSrtFromSegments,
  getSampleRateResamplingNote,
  prepareAudioForExport,
  type ExportResult,
  type ExportSegmentItem,
  type SrtCue,
  type SrtGenerationResult,
  type SrtSegmentInput,
} from './exporter';

export {
  measureLufs,
  removeDcOffsetInPlace,
} from './dsp';

export { OrderedStreamAudioPlayer } from './streamPlayer';
