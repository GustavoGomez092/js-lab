import { type CommandId, isCommandId } from "@jslab/shared";

export type ExecuteResult = "executed" | "unknown" | "disabled";

export interface CommandSpec {
  id: CommandId;
  run(args?: unknown): void | Promise<void>;
  isEnabled?(): boolean;
  /** Muted inline text in the palette, such as "currently on" (Task 20). */
  description?(): string | null;
}

/** Every action is a CommandId (spec §6.5). Menus, keys, the palette and E2E all execute through here. */
export class CommandRegistry {
  readonly #commands = new Map<CommandId, CommandSpec>();

  constructor(
    private readonly onError: (id: CommandId, error: unknown) => void = (id, error) =>
      console.error(`[jslab] command ${id} failed`, error),
  ) {}

  register(...specs: CommandSpec[]): void {
    for (const spec of specs) this.#commands.set(spec.id, spec);
  }

  has(id: string): id is CommandId {
    return isCommandId(id) && this.#commands.has(id);
  }

  get(id: string): CommandSpec | undefined {
    return isCommandId(id) ? this.#commands.get(id) : undefined;
  }

  isEnabled(id: string): boolean {
    const spec = this.get(id);
    return spec !== undefined && (spec.isEnabled?.() ?? true);
  }

  execute(id: string, args?: unknown): ExecuteResult {
    const spec = this.get(id);
    if (!spec) return "unknown";
    if (!(spec.isEnabled?.() ?? true)) return "disabled";
    try {
      const result = spec.run(args);
      if (result instanceof Promise) result.catch((error: unknown) => this.onError(spec.id, error));
    } catch (error) {
      this.onError(spec.id, error);
    }
    return "executed";
  }

  list(): CommandSpec[] {
    return [...this.#commands.values()];
  }
}
