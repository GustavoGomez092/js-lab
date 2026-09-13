process.send({ type: "ready", bun: Bun.version, execPath: process.execPath });
process.on("message", async (message) => {
  if (message.type !== "run") return;
  const result = { type: "result" };
  try {
    result.fixture = (await import("fixture")).default;
  } catch (error) {
    result.fixtureError = String(error);
  }
  result.tla = await Promise.resolve(42);
  result.dotenv = process.env.SPIKE_DOTENV ?? null;
  result.cwd = process.cwd();
  process.send(result);
});
