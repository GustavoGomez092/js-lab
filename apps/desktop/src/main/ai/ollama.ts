import type { AiMessage } from "@jslab/rpc-schema";
import { type AiProviderAdapter, type AiRequest, AiRequestError, errorKindForStatus } from "./provider";
import { readNdjsonStream } from "./stream";

/**
 * The Ollama adapter (spec §14.3: `POST /api/chat` streaming, `GET /api/tags` for models, default base
 * `http://localhost:11434`).
 *
 * Ollama needs no API key, which makes it the one provider where key handling could be quietly skipped. It is
 * deliberately NOT skipped: `AiRequest.apiKey` is threaded through here like everywhere else and sent as a
 * bearer token whenever it is present. That is not ceremony -- a self-hosted Ollama behind an authenticating
 * reverse proxy is a real deployment, and it is the only way the key path gets exercised at all before a keyed
 * provider exists to exercise it.
 */

/** How much of an error body is read back. Error bodies are short; this only stops an unbounded one. */
const MAX_ERROR_BODY_CHARS = 4096;

/** One line of `/api/chat`'s NDJSON. Every field is optional: this is a remote server's JSON, not ours. */
interface OllamaChatLine {
  message?: { content?: unknown };
  done?: unknown;
  error?: unknown;
}

interface OllamaTagsBody {
  models?: { name?: unknown }[];
}

function headersFor(apiKey: string | null): Record<string, string> {
  return {
    "content-type": "application/json",
    // The key seam: present only when there is a key. A keyed provider differs from this line by its header
    // NAME (`x-api-key` for Anthropic), not by whether the key reaches the adapter at all.
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

/**
 * Classifies a non-2xx response. The body is read for the provider's own words, which is where Ollama puts
 * "model ... not found" and its context-length complaints -- a status code alone cannot tell those apart from
 * any other 400.
 *
 * Built from the RESPONSE only. Nothing derived from the request -- and therefore never the API key -- can reach
 * the error the renderer is shown.
 */
async function failureFor(response: Response): Promise<AiRequestError> {
  let body = "";
  try {
    body = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    // A failed read of an error body is not itself interesting; the status still classifies the failure.
  }
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim() !== "") detail = parsed.error.trim();
  } catch {
    // Not JSON: the raw text is the best detail available.
  }
  const lowered = detail.toLowerCase();
  // Ollama answers an over-long prompt with a 400 whose text names the context, not with a 413.
  if (lowered.includes("context length") || lowered.includes("too long") || lowered.includes("exceeds context")) {
    return new AiRequestError("contextTooLong", detail);
  }
  if (lowered.includes("not found") && lowered.includes("model")) {
    return new AiRequestError("modelNotFound", detail);
  }
  return new AiRequestError(errorKindForStatus(response.status), detail === "" ? `HTTP ${response.status}` : detail);
}

/** A thrown non-`AiRequestError` is a transport failure: DNS, connection refused, a socket reset mid-stream. */
function transportFailure(error: unknown): AiRequestError {
  if (error instanceof AiRequestError) return error;
  return new AiRequestError("network", error instanceof Error ? error.message : String(error));
}

/**
 * The part of `fetch` this adapter uses.
 *
 * Deliberately a plain call signature rather than `typeof fetch`: Bun's global carries extra members (notably
 * `preconnect`) that no test stand-in can reasonably supply, so `typeof fetch` would make the seam injectable in
 * name only. The same shape `rpc/web-fetch-handlers.ts` already uses for its own injected fetch.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OllamaAdapterDeps {
  /** Injected so the adapter is testable without a server; production passes the global. */
  fetch?: FetchLike;
  /** Bounds for the streaming read; defaults live in `stream.ts`. */
  maxBytes?: number;
  stallMs?: number;
}

export function createOllamaAdapter(deps: OllamaAdapterDeps = {}): AiProviderAdapter {
  const doFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));

  return {
    id: "ollama",
    // Ollama is the reason this flag exists rather than every adapter re-deciding: it is the only `false`.
    needsApiKey: false,

    async chat(request: AiRequest, onChunk: (text: string) => void): Promise<void> {
      // The controller this function owns, chained to the caller's signal. `readNdjsonStream` aborts it to
      // enforce its own bounds, and aborting it tears down the real HTTP request rather than just ending the read.
      const controller = new AbortController();
      const relayAbort = () => controller.abort();
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener("abort", relayAbort, { once: true });

      try {
        let response: Response;
        try {
          response = await doFetch(`${request.baseUrl}/api/chat`, {
            method: "POST",
            headers: headersFor(request.apiKey),
            body: JSON.stringify({
              model: request.model,
              messages: request.messages.map((message: AiMessage) => ({
                role: message.role,
                content: message.content,
              })),
              stream: true,
            }),
            signal: controller.signal,
          });
        } catch (error) {
          throw transportFailure(error);
        }
        if (!response.ok) throw await failureFor(response);
        if (!response.body) throw new AiRequestError("network", "The provider returned no response body");

        const result = await readNdjsonStream({
          body: response.body,
          controller,
          ...(deps.maxBytes === undefined ? {} : { maxBytes: deps.maxBytes }),
          ...(deps.stallMs === undefined ? {} : { stallMs: deps.stallMs }),
          onLine: (line) => {
            let parsed: OllamaChatLine;
            try {
              parsed = JSON.parse(line) as OllamaChatLine;
            } catch {
              // A line that is not JSON is not a reason to fail a turn that is otherwise streaming fine: Ollama
              // has been known to emit blank or keep-alive lines, and a stricter reader would turn those into a
              // user-visible error for a reply that arrived correctly.
              return;
            }
            // An error can arrive INSIDE a 200 stream (a model unloaded mid-turn), which is the one case a
            // status check can never catch.
            if (typeof parsed.error === "string" && parsed.error.trim() !== "") {
              throw new AiRequestError("http", parsed.error.trim());
            }
            const content = parsed.message?.content;
            if (typeof content === "string" && content !== "") onChunk(content);
            // The provider's own end-of-turn. Returning true here is what lets a body that merely ENDED be told
            // apart from a turn that finished (see `stream.ts`).
            return parsed.done === true;
          },
        });

        if (!result.completed) {
          // Case 2: the body ended without Ollama ever saying `done`. The server died, or the connection was
          // cut. Reporting success here would show the user a silently truncated answer as though it were whole.
          throw new AiRequestError("network", "The provider closed the connection before finishing its reply");
        }
      } catch (error) {
        throw transportFailure(error);
      } finally {
        request.signal.removeEventListener("abort", relayAbort);
      }
    },

    async listModels(request): Promise<string[]> {
      let response: Response;
      try {
        response = await doFetch(`${request.baseUrl}/api/tags`, {
          headers: headersFor(request.apiKey),
          signal: request.signal,
        });
      } catch (error) {
        throw transportFailure(error);
      }
      if (!response.ok) throw await failureFor(response);
      let body: OllamaTagsBody;
      try {
        body = (await response.json()) as OllamaTagsBody;
      } catch (error) {
        throw new AiRequestError("network", error instanceof Error ? error.message : String(error));
      }
      return (body.models ?? [])
        .map((entry) => entry?.name)
        .filter((name): name is string => typeof name === "string" && name !== "");
    },
  };
}
