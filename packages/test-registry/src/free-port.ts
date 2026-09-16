/** A loopback port that was free a moment ago (the registry binds it right after). */
export function findFreePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
}
