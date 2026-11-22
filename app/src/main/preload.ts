import { contextBridge, ipcRenderer } from "electron";

const CHANNELS = ["snapshot", "line", "reset", "interim", "level", "saved"];

// Sandboxed preload: the panel only gets these three functions.
contextBridge.exposeInMainWorld("keypad", {
  init: () => ipcRenderer.invoke("panel:init"),
  control: (cmd: string, arg?: string) => ipcRenderer.send("panel:control", cmd, arg),
  on: (channel: string, cb: (payload: unknown) => void) => {
    if (!CHANNELS.includes(channel)) return;
    ipcRenderer.on(`panel:${channel}`, (_e, payload) => cb(payload));
  },
});
