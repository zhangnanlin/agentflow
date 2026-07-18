import {
  NativeWorkerAdapter,
  type NativeHostClient,
  type NativeWorkerAdapterOptions,
  type NativeWorkerHandle
} from "./native.js";

export class CodexNativeWorkerAdapter extends NativeWorkerAdapter {
  constructor(
    client: NativeHostClient,
    options: NativeWorkerAdapterOptions,
    restoredHandles: NativeWorkerHandle[] = []
  ) {
    super("codex", client, options, restoredHandles);
  }
}
