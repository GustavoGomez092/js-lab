/** Writes into a focused plain input/textarea (not Monaco's). Returns false when the target isn't one. */
export function typeIntoField(target: EventTarget, text: string, replace: boolean): boolean {
  const isField =
    target instanceof HTMLInputElement || (target instanceof HTMLTextAreaElement && !target.closest(".monaco-editor"));
  if (!isField) return false;
  const field = target as HTMLInputElement | HTMLTextAreaElement;
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  // React tracks the value through the native setter; assigning `.value` directly would skip onChange.
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, replace ? text : field.value + text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}
