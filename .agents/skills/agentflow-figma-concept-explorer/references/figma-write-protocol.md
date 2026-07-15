# Figma Write Protocol

Use this sequence for every mutating `use_figma` call:

1. Confirm the `figma-file` resource lease and Worker task lease are unexpired.
2. Confirm S04 is active and its latest live capability preflight is still passed and unexpired. Re-probe after a host restart or expired report.
3. Call `resource_operation_begin` with a unique operation ID and tool `figma.use_figma.write`. Core rechecks the Stage, leases, bound Worker, and preflight at this boundary.
4. Load official `figma-use` instructions and issue one small `use_figma` script.
5. Use top-level `await` and `return`. Do not wrap an async IIFE, call `figma.closePlugin()`, or use `figma.notify()`.
6. Load fonts before any text mutation.
7. Set the target page with `setCurrentPageAsync` at most once in the call.
8. Return all created and mutated node IDs in a structured result.
9. On success, hash the returned JSON and call `resource_operation_finish` with `completed`, the result hash, and every affected node ID.
10. On error, inspect the error before retrying and call `resource_operation_finish` with `failed` and a concise summary.
11. Do not start the next write until the previous operation is finished.

`get_metadata` and `get_screenshot` are validation reads. They do not replace the write result ledger. Keep screenshots tied to the concept and source node IDs.

An expired lease with an active operation requires manual reconciliation; never let a second Writer take over while the external call may still be running.
