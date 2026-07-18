import {
  NativeWorkerAdapter,
  type NativeHostClient,
  type NativeWorkerAdapterOptions,
  type NativeWorkerHandle
} from "./native.js";

export class CursorNativeWorkerAdapter extends NativeWorkerAdapter {
  constructor(
    client: NativeHostClient,
    options: NativeWorkerAdapterOptions,
    restoredHandles: NativeWorkerHandle[] = []
  ) {
    super("cursor", client, options, restoredHandles);
  }
}
