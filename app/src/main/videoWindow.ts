import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { BrowserWindow, screen } from "electron";

/** Mock playback state the video follows (MockSource.state()). */
export interface VideoSync {
  playing: boolean;
  position: number;
  speed: number;
}

export interface VideoWindowOptions {
  appRoot: string;
  log: (msg: string) => void;
}

const MARGIN = 24;
const MAX_WIDTH = 1000;
/** Room left for the IntelliPad window docked at the right edge. */
const PANEL_ROOM = 360 + 2 * MARGIN;

/**
 * A recorded call (video scenario) playing next to IntelliPad in Mock mode. It follows the mock
 * playback (play, pause, restart, speed) and corrects drift; the transcript and keys come from the
 * scenario's meeting.json as usual. Closing the window just hides the video; the next Play reopens it.
 */
export class VideoWindow {
  private win: BrowserWindow | null = null;
  private loaded = false;
  private file: string | null = null;
  private title = "";
  private aspect = 1280 / 766;
  private last: VideoSync | null = null;

  constructor(private readonly o: VideoWindowOptions) {}

  /** Show this video (absolute path), paused at the start. */
  open(file: string, title: string): void {
    if (this.file === file && this.win && !this.win.isDestroyed()) return;
    this.file = file;
    this.title = title;
    this.last = null;
    this.ensure();
  }

  close(): void {
    this.file = null;
    this.last = null;
    const w = this.win;
    this.win = null;
    if (w && !w.isDestroyed()) w.destroy();
  }

  isOpen(): boolean {
    return this.file !== null;
  }

  sync(s: VideoSync): void {
    if (!this.file) return;
    const started = s.playing && !(this.last?.playing ?? false);
    if (s.playing !== (this.last?.playing ?? false)) this.o.log(`${s.playing ? "play" : "pause"} at ${s.position.toFixed(1)} s (×${s.speed})`);
    this.last = s;
    if (s.playing && (!this.win || this.win.isDestroyed())) this.ensure(); // closed by the user: Play reopens it
    if (started) this.bringToFront();
    if (this.win && !this.win.isDestroyed() && this.loaded) this.win.webContents.send("video:sync", s);
  }

  /** On Play: un-minimise and put the call above other apps' windows, without taking the keyboard. */
  private bringToFront(): void {
    const w = this.win;
    if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    if (!w.isVisible()) w.showInactive();
    w.moveTop();
  }

  /** For checks: the window exists and is on screen. */
  visible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  private ensure(): void {
    if (!this.file) return;
    if (this.win && !this.win.isDestroyed()) {
      this.loaded = false;
      this.win.setTitle(this.title);
      void this.win.loadFile(join(this.o.appRoot, "static", "video.html"));
      return;
    }
    const { workArea } = screen.getPrimaryDisplay();
    const width = Math.min(MAX_WIDTH, workArea.width - PANEL_ROOM - MARGIN);
    const height = Math.round(width / this.aspect);
    const win = new BrowserWindow({
      x: workArea.x + MARGIN,
      y: workArea.y + MARGIN,
      width,
      height,
      useContentSize: true,
      show: false,
      title: this.title,
      backgroundColor: "#000000",
      webPreferences: {
        preload: join(__dirname, "videoPreload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setAspectRatio(this.aspect);
    this.win = win;
    win.showInactive(); // visible at once (black until the video loads); IntelliPad keeps the keyboard
    this.loaded = false;
    win.on("closed", () => {
      if (this.win === win) this.win = null;
    });
    win.webContents.on("did-finish-load", () => {
      if (this.win !== win || !this.file) return;
      this.loaded = true;
      win.webContents.send("video:load", pathToFileURL(this.file).href);
      if (this.last) win.webContents.send("video:sync", this.last);
    });
    win.webContents.on("did-fail-load", (_e, code, desc) => this.o.log(`video page failed to load: ${desc} (${code})`));
    void win.loadFile(join(this.o.appRoot, "static", "video.html"));
    this.o.log(`video: ${this.file}`);
  }
}
