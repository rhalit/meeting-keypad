import { contextBridge, ipcRenderer } from "electron";

// Sandboxed preload for the overlay card window. Shapes: OverlayCard in src/pipeline/overlay.ts.
contextBridge.exposeInMainWorld("overlay", {
  onCard: (cb: (card: unknown) => void) => ipcRenderer.on("overlay:card", (_e, card) => cb(card)),
  onUpdate: (cb: (card: unknown) => void) => ipcRenderer.on("overlay:update", (_e, card) => cb(card)),
  onReveal: (cb: (id: number) => void) => ipcRenderer.on("overlay:reveal", (_e, id) => cb(id)),
  onHide: (cb: () => void) => ipcRenderer.on("overlay:hide", () => cb()),
  onTheme: (cb: (theme: string) => void) => ipcRenderer.on("overlay:theme", (_e, theme) => cb(theme)),
  sized: (id: number, height: number) => ipcRenderer.send("overlay:size", { id, height }),
  shown: (id: number) => ipcRenderer.send("overlay:shown", id),
});
