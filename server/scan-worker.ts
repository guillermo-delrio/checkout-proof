// Runs one repo scan off the main thread (review r3, A1): if a crafted repo ever makes the rules slow, the server
// terminates this worker after LIMITS.scanMs and keeps answering pages, live runs and webhooks.
import { parentPort, workerData } from "node:worker_threads";
import { scanTarGz, ScanError } from "./scan-repo.ts";

try {
  parentPort!.postMessage({ ok: true, result: scanTarGz(Buffer.from(workerData.tgz), workerData.label) });
} catch (e: any) {
  parentPort!.postMessage({ ok: false, code: e instanceof ScanError ? e.code : "bad-archive", message: e instanceof ScanError ? e.message : "GitHub's archive could not be read." });
}
