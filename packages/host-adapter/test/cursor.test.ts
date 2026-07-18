import { CursorNativeWorkerAdapter } from "../src/index.js";
import { nativeAdapterConformance } from "./native-conformance.js";

nativeAdapterConformance("cursor", false, (host, budget) => (
  new CursorNativeWorkerAdapter(host, { budget })
));
