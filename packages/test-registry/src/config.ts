/**
 * Verdaccio config for tests: storage under a temp folder, loopback only, no uplinks (so no public registry is ever
 * contacted), the web UI off, and anonymous publish so fixtures can be published without accounts.
 */
export function verdaccioConfig(input: { storage: string; port: number }): string {
  return [
    `storage: ${JSON.stringify(input.storage)}`,
    `listen: 127.0.0.1:${input.port}`,
    "max_body_size: 100mb",
    "web:",
    "  enable: false",
    "uplinks: {}",
    "middlewares:",
    "  audit:",
    "    enabled: false",
    "packages:",
    "  '@*/*':",
    "    access: $all",
    "    publish: $anonymous",
    "    unpublish: $anonymous",
    "  '**':",
    "    access: $all",
    "    publish: $anonymous",
    "    unpublish: $anonymous",
    "log:",
    "  type: stdout",
    "  format: pretty",
    "  level: warn",
    "",
  ].join("\n");
}
