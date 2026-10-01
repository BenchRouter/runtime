// BenchRouter runtime entry (RUN-001). The bootstrap execs this file after it verified
// the signed release. Commands: `run` (GitHub Actions), and the local `capture` and
// `calibrate`, which keep CLI authentication. Anything else fails closed.
import { runCalibrate } from "./calibrate";
import { runCapture } from "./capture";
import { loadControlContext } from "./control";
import { errorMessage } from "./json";
import { killAllGroupsNow } from "./processes";
import { runScorerHost } from "./scorer-host";
import { SCORER_HOST_COMMAND } from "./scorer-process";
import { runWorker } from "./session";

async function main(): Promise<number> {
  const command = process.argv[2] ?? "";
  if (command === SCORER_HOST_COMMAND) {
    runScorerHost();
    return -1;
  }
  // The IPC channel to the bootstrap (retire_at reports) must not keep this process alive.
  process.channel?.unref();
  process.on("exit", killAllGroupsNow);
  // Capture runs until the developer stops it: a signal ends it cleanly after its writes.
  const stopCapture = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (command === "capture" && !stopCapture.signal.aborted) {
        stopCapture.abort();
        return;
      }
      killAllGroupsNow();
      process.exit(1);
    });
  }
  const control = loadControlContext();
  if (command === "run") return runWorker(control);
  if (command === "capture") return runCapture(control, stopCapture.signal);
  if (command === "calibrate") return runCalibrate(control, process.argv.slice(3));
  console.error(`::error title=BenchRouter::unknown runtime command ${JSON.stringify(command)}`);
  return 1;
}

main().then(
  (code) => {
    // Exit explicitly: an idle keep-alive socket must not hold the job open.
    if (code >= 0) process.exit(code);
  },
  (error: Error) => {
    console.error(`::error title=BenchRouter runtime::${errorMessage(error)}`);
    process.exit(1);
  }
);
