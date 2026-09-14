import { chmodSync, existsSync, unlinkSync } from "node:fs";
import type { Socket } from "bun";
import { assertSocketPath, encodeLine, handleLine, LineBuffer, type SocketMethod } from "./ndjson";

export interface SocketServer {
  path: string;
  close(): void;
}

interface Connection {
  buffer: LineBuffer;
  decoder: TextDecoder;
}

async function isListening(path: string): Promise<boolean> {
  try {
    const socket = await Bun.connect({ unix: path, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * The `jslab.sock` server (spec §16.3). It speaks newline-delimited JSON. The socket is created with a 0177 umask
 * and then chmod 0600, so no other user can connect at any point. M5's CLI reuses this server with an `open` method.
 */
export async function startSocketServer(options: {
  path: string;
  methods: Record<string, SocketMethod>;
  log(message: string, detail?: unknown): void;
}): Promise<SocketServer> {
  assertSocketPath(options.path);
  if (existsSync(options.path)) {
    if (await isListening(options.path)) throw new Error(`Another JSLab instance is listening on ${options.path}`);
    unlinkSync(options.path);
  }

  const connections = new WeakMap<Socket<undefined>, Connection>();
  const previousUmask = process.umask(0o177);
  let listener: ReturnType<typeof Bun.listen<undefined>>;
  try {
    listener = Bun.listen<undefined>({
      unix: options.path,
      socket: {
        open(socket) {
          connections.set(socket, { buffer: new LineBuffer(), decoder: new TextDecoder() });
        },
        data(socket, data) {
          const connection = connections.get(socket);
          if (!connection) return;
          let lines: string[];
          try {
            lines = connection.buffer.push(connection.decoder.decode(data, { stream: true }));
          } catch (error) {
            options.log("Socket request rejected", String(error));
            socket.end();
            return;
          }
          for (const line of lines) {
            void handleLine(line, options.methods).then((response) => {
              socket.write(encodeLine(response));
            });
          }
        },
        close(socket) {
          connections.delete(socket);
        },
        error(_socket, error) {
          options.log("Socket error", String(error));
        },
      },
    });
  } finally {
    process.umask(previousUmask);
  }
  chmodSync(options.path, 0o600);

  return {
    path: options.path,
    close() {
      listener.stop(true);
      if (existsSync(options.path)) unlinkSync(options.path);
    },
  };
}
