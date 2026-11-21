import { contextBridge, ipcRenderer } from "electron";

// Sandboxed preload: the panel only gets these three functions.
contextBridge.exposeInMainWorld("keypad", {
  init: () => ipcRenderer.invoke("panel:init"),
  control: (cmd: string) => ipcRenderer.send("panel:control", cmd),
  on: (channel: "snapshot" | "line" | "reset", cb: (payload: unknown) => void) => {
    if (!["snapshot", "line", "reset"].includes(channel)) return;
    ipcRenderer.on(`panel:${channel}`, (_e, payload) => cb(payload));
  },
});
