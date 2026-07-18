import { VsCodeNativeWorkerAdapter } from "../src/index.js";
import { nativeAdapterConformance } from "./native-conformance.js";

nativeAdapterConformance("vscode", false, (host, budget) => (
  new VsCodeNativeWorkerAdapter(host, { budget })
));
