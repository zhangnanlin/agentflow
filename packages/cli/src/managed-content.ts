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
  const start = existing.indexOf(markers.start);
  const end = existing.indexOf(markers.end);
  if (starts > 1 || ends > 1 || starts !== ends || (starts === 1 && end < start)) {
    throw new AgentFlowError(
      "Managed AgentFlow block is malformed",
      "MANAGED_BLOCK_INVALID",
      { starts, ends }
    );
  }

  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const normalizedBody = body.trim().replace(/\r?\n/g, newline);
  const block = `${markers.start}${newline}${normalizedBody}${newline}${markers.end}`;
  if (starts === 0) {
    if (existing.length === 0) return `${block}${newline}`;
    const separator = existing.endsWith(`${newline}${newline}`)
      ? ""
      : existing.endsWith(newline)
        ? newline
        : `${newline}${newline}`;
    return `${existing}${separator}${block}${newline}`;
  }

  const blockEnd = end + markers.end.length;
  return `${existing.slice(0, start)}${block}${existing.slice(blockEnd)}`;
}
