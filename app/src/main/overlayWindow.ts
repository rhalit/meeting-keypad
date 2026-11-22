import { join } from "node:path";
import { BrowserWindow, ipcMain, screen } from "electron";
import type { OverlayCard } from "../pipeline/overlay.js";

export const OVERLAY_WIDTH = 380;
export const OVERLAY_MARGIN = 24;
const FADE_MS = 150;

export interface OverlayWindowOptions {
  appRoot: string;
  /** Called once the card with this id has been painted on screen. */
  onShown: (id: number) => void;
  log: (msg: string) => void;
}

/**
 * The always-on-top card window. Never takes focus (non-activating panel, not focusable,
 * shown with showInactive) and is click-through, so the meeting app keeps keyboard and mouse.
 *
 * Show: send card -> renderer measures and replies with its height -> resize + showInactive ->
 * reveal (fade in) -> renderer reports the painted frame. Update (streaming text card): send the
 * new card -> renderer re-measures -> resize only. Hide: fade out, then hide the window.
 */
export class OverlayWindow {
  private readonly win: BrowserWindow;
  private loaded = false;
  private pending: OverlayCard | null = null;
  private currentId: number | null = null;
  private revealedId: number | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private theme: string = "dark";

  constructor(private readonly opts: OverlayWindowOptions) {
    const isMac = process.platform === "darwin";
    this.win = new BrowserWindow({
      ...(isMac ? { type: "panel" } : {}),
      width: OVERLAY_WIDTH,
      height: 300,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      title: "Meeting Keypad overlay",
      webPreferences: {
        preload: join(__dirname, "overlayPreload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.win.setAlwaysOnTop(true, "screen-saver");
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    this.win.setIgnoreMouseEvents(true);
    if (isMac) this.win.setHiddenInMissionControl(true);

    ipcMain.on("overlay:size", this.onSize);
    ipcMain.on("overlay:shown", this.onShownMsg);
    this.win.webContents.once("did-finish-load", () => {
      this.loaded = true;
      this.win.webContents.send("overlay:theme", this.theme);
      if (this.pending) this.show(this.pending);
      this.pending = null;
    });
    this.win.webContents.on("did-fail-load", (_e, code, desc) => opts.log(`card page failed to load: ${desc} (${code})`));
    this.win.webContents.on("render-process-gone", (_e, d) => opts.log(`card renderer gone: ${d.reason}`));
    void this.win.loadFile(join(opts.appRoot, "static", "overlay.html"));
  }

  show(card: OverlayCard): void {
    if (this.win.isDestroyed()) return;
    this.cancelHide();
    if (!this.loaded) {
      this.pending = card;
      return;
    }
    this.currentId = card.id;
    this.win.webContents.send("overlay:card", card);
  }

  /** "dark" or "light" (panel Settings). Applied now, or as soon as the page has loaded. */
  setTheme(theme: string): void {
    this.theme = theme;
    if (this.loaded && !this.win.isDestroyed()) this.win.webContents.send("overlay:theme", theme);
  }

  /** Same card id with new content (text card filling in). */
  update(card: OverlayCard): void {
    if (this.win.isDestroyed()) return;
    if (!this.loaded) {
      if (this.pending?.id === card.id) this.pending = card;
      return;
    }
    if (card.id !== this.currentId) return;
    this.win.webContents.send("overlay:update", card);
  }

  hide(): void {
    this.pending = null;
    this.currentId = null;
    this.revealedId = null;
    if (this.win.isDestroyed() || !this.win.isVisible()) return;
    this.win.webContents.send("overlay:hide");
    this.cancelHide();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (!this.win.isDestroyed() && this.currentId === null) this.win.hide();
    }, FADE_MS + 20);
  }

  destroy(): void {
    this.cancelHide();
    ipcMain.off("overlay:size", this.onSize);
    ipcMain.off("overlay:shown", this.onShownMsg);
    if (!this.win.isDestroyed()) this.win.destroy();
  }

  private readonly onSize = (e: Electron.IpcMainEvent, msg: { id: number; height: number }): void => {
    if (e.sender !== this.win.webContents || msg.id !== this.currentId) return;
    const { workArea } = screen.getPrimaryDisplay();
    const height = Math.min(Math.ceil(msg.height), workArea.height - 2 * OVERLAY_MARGIN);
    this.win.setBounds({
      x: workArea.x + workArea.width - OVERLAY_WIDTH - OVERLAY_MARGIN,
      y: workArea.y + OVERLAY_MARGIN,
      width: OVERLAY_WIDTH,
      height,
    });
    if (this.revealedId === msg.id) return; // a later size of a visible card: resize only
    this.revealedId = msg.id;
    if (!this.win.isVisible()) this.win.showInactive();
    this.win.webContents.send("overlay:reveal", msg.id);
  };

  private readonly onShownMsg = (e: Electron.IpcMainEvent, id: number): void => {
    if (e.sender !== this.win.webContents || id !== this.currentId) return;
    this.opts.onShown(id);
  };

  private cancelHide(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }
}
