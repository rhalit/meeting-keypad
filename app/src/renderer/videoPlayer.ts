// Video window: plays a recorded call in step with the mock playback (src/main/videoWindow.ts).

interface VideoSyncMsg {
  playing: boolean;
  position: number;
  speed: number;
}
interface VideoApi {
  onLoad(cb: (url: string) => void): void;
  onSync(cb: (s: VideoSyncMsg) => void): void;
}
interface Window {
  video: VideoApi;
}

{
  const v = document.getElementById("v") as HTMLVideoElement;
  /** Drift above this is corrected by seeking. */
  const MAX_DRIFT_S = 0.35;

  window.video.onLoad((url) => {
    v.src = url;
    v.currentTime = 0;
  });

  window.video.onSync((s) => {
    v.playbackRate = s.speed;
    const target = Math.min(s.position, Number.isFinite(v.duration) ? v.duration : s.position);
    if (Math.abs(v.currentTime - target) > MAX_DRIFT_S) v.currentTime = target;
    // After the end, Play restarts the mock at 0: the seek above already moved the video back.
    if (s.playing && v.paused) void v.play().catch(() => {});
    else if (!s.playing && !v.paused) v.pause();
  });
}
