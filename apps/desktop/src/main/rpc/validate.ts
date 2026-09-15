export class InvalidPayloadError extends Error {}

export interface SafeParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { message: string } };
}

export type Log = (message: string, detail?: unknown) => void;

/** Every inbound payload is validated before use (spec §18). */
export function createValidators(log: Log) {
  const parse = <T>(schema: SafeParser<T>, method: string, input: unknown): T => {
    const result = schema.safeParse(input);
    if (!result.success) {
      log(`Rejected invalid ${method} payload`, result.error.message);
      throw new InvalidPayloadError(`Invalid payload for ${method}`);
    }
    return result.data;
  };

  // Messages are fire-and-forget: an invalid one is logged and dropped, never thrown into the RPC layer.
  const message =
    <T>(schema: SafeParser<T>, method: string, handle: (payload: T) => void | Promise<void>) =>
    (input: unknown): void => {
      try {
        const result = handle(parse(schema, method, input));
        if (result instanceof Promise)
          result.catch((error: unknown) => log(`Handler for ${method} failed`, String(error)));
      } catch (error) {
        if (!(error instanceof InvalidPayloadError)) log(`Handler for ${method} failed`, String(error));
      }
    };

  return { parse, message };
}
