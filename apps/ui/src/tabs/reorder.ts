import { moveTab } from "@jslab/shared";

/** Order after dropping `draggedId` before (or after) `targetId`. */
export function reorderByDrop(order: string[], draggedId: string, targetId: string, after: boolean): string[] {
  const from = order.indexOf(draggedId);
  const target = order.indexOf(targetId);
  if (from < 0 || target < 0 || draggedId === targetId) return order;
  let to = after ? target + 1 : target;
  if (from < to) to -= 1;
  return moveTab(order, draggedId, to);
}
