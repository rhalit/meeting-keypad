#!/usr/bin/env node
// Stand-in for audiotee in tests. Mode from FAKE_AUDIOTEE_MODE:
//   ok      JSON logs on stderr, then 100 ms chunks of a tone on stdout until SIGTERM
//   silent  same, but all-zero samples
//   fail    logs an error (like a failed tap setup) and exits 1
//   hang    stream_start, then no audio (like waiting for the permission prompt); ignores SIGTERM
const mode = process.env.FAKE_AUDIOTEE_MODE ?? "ok";
const log = (message_type, data) =>
  process.stderr.write(JSON.stringify({ timestamp: new Date().toISOString(), message_type, data }) + "\n");

log("info", { message: "Starting AudioTee..." });
if (mode === "fail") {
  log("error", { message: "Failed to setup audio tap", context: { error: "tapCreationFailed(-1)" } });
  process.exit(1);
}
log("metadata", { sample_rate: 16000, encoding: "pcm_s16le", channels_per_frame: 1 });
log("stream_start");
if (mode === "hang") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  process.on("SIGTERM", () => {
    log("info", { message: "Received SIGTERM, initiating graceful shutdown..." });
    log("stream_stop");
    process.exit(0);
  });
  const chunk = Buffer.alloc(3200);
  if (mode === "ok") for (let i = 0; i < 1600; i++) chunk.writeInt16LE(i % 2 ? 3000 : -3000, i * 2);
  // Odd-sized writes on purpose: the reader must keep samples aligned.
  setInterval(() => {
    process.stdout.write(chunk.subarray(0, 1601));
    process.stdout.write(chunk.subarray(1601));
  }, 100);
}
