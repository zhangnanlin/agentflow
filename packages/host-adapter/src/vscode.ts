import {
  NativeWorkerAdapter,
  type NativeHostClient,
  type NativeWorkerAdapterOptions,
  type NativeWorkerHandle
} from "./native.js";

export class VsCodeNativeWorkerAdapter extends NativeWorkerAdapter {
  constructor(
    client: NativeHostClient,
    options: NativeWorkerAdapterOptions,
    restoredHandles: NativeWorkerHandle[] = []
  ) {
    super("vscode", client, options, restoredHandles);
  }
}
