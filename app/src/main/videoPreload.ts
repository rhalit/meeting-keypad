import { contextBridge, ipcRenderer } from "electron";

// Sandboxed preload for the video window (src/main/videoWindow.ts).
contextBridge.exposeInMainWorld("video", {
  onLoad: (cb: (url: string) => void) => ipcRenderer.on("video:load", (_e, url) => cb(url)),
  onSync: (cb: (s: unknown) => void) => ipcRenderer.on("video:sync", (_e, s) => cb(s)),
});
