import { AgentFlowError } from "@agentflow/core";

export interface ManagedMarkers {
  start: string;
  end: string;
}

export function mergeManagedBlock(
  existing: string,
  body: string,
  markers: ManagedMarkers
): string {
  const starts = existing.split(markers.start).length - 1;
  const ends = existing.split(markers.end).length - 1;
  if (starts > 1 || ends > 1 || starts !== ends) {
    throw new AgentFlowError(
      "Managed AgentFlow block is malformed",
      "MANAGED_BLOCK_INVALID",
      { starts, ends }
    );
  }

  const block = `${markers.start}\n${body.trim()}\n${markers.end}`;
  if (starts === 0) {
    return `${existing.trimEnd()}${existing.trim().length === 0 ? "" : "\n\n"}${block}\n`;
  }

  const start = existing.indexOf(markers.start);
  const end = existing.indexOf(markers.end, start) + markers.end.length;
  return `${existing.slice(0, start)}${block}${existing.slice(end)}`
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}
