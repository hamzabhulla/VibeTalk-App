import { PermissionsAndroid, Platform } from "react-native";
import AudioRecorderPlayer, {
  AVEncoderAudioQualityIOSType,
  AVEncodingOption,
  AudioEncoderAndroidType,
  AudioSourceAndroidType,
  OutputFormatAndroidType,
} from "react-native-audio-recorder-player";

// Voice notes: record AAC (.m4a — plays on the web app too), send
// through the same attachment pipeline as photos (type 'audio').

export const recorder = new AudioRecorderPlayer();

export async function ensureMicPermission(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const res = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
  );
  return res === PermissionsAndroid.RESULTS.GRANTED;
}

export async function startRecording(
  onProgress: (ms: number) => void,
): Promise<void> {
  lastDurationMs = 0;
  recorder.addRecordBackListener((e) => {
    lastDurationMs = e.currentPosition;
    onProgress(e.currentPosition);
  });
  await recorder.startRecorder(undefined, {
    AudioEncoderAndroid: AudioEncoderAndroidType.AAC,
    AudioSourceAndroid: AudioSourceAndroidType.MIC,
    OutputFormatAndroid: OutputFormatAndroidType.MPEG_4,
    AVEncoderAudioQualityKeyIOS: AVEncoderAudioQualityIOSType.high,
    AVFormatIDKeyIOS: AVEncodingOption.aac,
  });
}

/** Stops and returns { uri, durationMs } for the finished note. */
export async function stopRecording(): Promise<{
  uri: string;
  durationMs: number;
}> {
  const uri = await recorder.stopRecorder();
  recorder.removeRecordBackListener();
  // The recorder's final position arrives via the progress listener;
  // duration is also stored from the last callback by the caller.
  return { uri, durationMs: lastDurationMs };
}

let lastDurationMs = 0;

export async function cancelRecording(): Promise<void> {
  try {
    await recorder.stopRecorder();
  } catch {
    /* already stopped */
  }
  recorder.removeRecordBackListener();
}

// ---- Playback (one stream at a time, app-wide) ----

let playingId: string | null = null;
const playListeners = new Set<() => void>();

export function onPlayStateChange(fn: () => void) {
  playListeners.add(fn);
  return () => {
    playListeners.delete(fn);
  };
}

function notifyPlay() {
  for (const fn of [...playListeners]) fn();
}

export function currentPlayingId() {
  return playingId;
}

// Durations learned from the player itself — received voice notes
// carry no durationMs in their (server-contract) meta, so the
// bubble falls back to the duration the player reports on play.
const knownDurations = new Map<string, number>();

export function knownDuration(id: string): number | undefined {
  return knownDurations.get(id);
}

export async function playAudio(id: string, uri: string): Promise<void> {
  if (playingId === id) {
    await recorder.pausePlayer();
    playingId = null;
    notifyPlay();
    return;
  }
  try {
    await recorder.stopPlayer();
  } catch {
    /* nothing playing */
  }
  recorder.removePlayBackListener();
  playingId = id;
  notifyPlay();
  recorder.addPlayBackListener((e) => {
    if (e.duration > 0 && playingId) {
      if (knownDurations.get(playingId) !== e.duration) {
        knownDurations.set(playingId, e.duration);
        notifyPlay();
      }
    }
    if (e.currentPosition >= e.duration && e.duration > 0) {
      playingId = null;
      recorder.removePlayBackListener();
      notifyPlay();
    }
  });
  await recorder.startPlayer(uri);
}

export async function stopAudio(): Promise<void> {
  try {
    await recorder.stopPlayer();
  } catch {
    /* nothing playing */
  }
  recorder.removePlayBackListener();
  playingId = null;
  notifyPlay();
}

export function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return "0:00";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
