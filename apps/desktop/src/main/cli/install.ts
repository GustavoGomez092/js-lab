import { mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";

export type InstallScope = "user" | "allUsers";

/** Spec §16.1. The user scope is the default and never escalates; the all-users scope is an explicit opt-in. */
export const USER_BIN_SUBPATH = ".local/bin";
export const SYSTEM_BIN_DIR = "/usr/local/bin";
export const LINK_NAME = "jslab";

export interface CliInstallFs {
  mkdir(dir: string): Promise<void>;
  symlink(target: string, link: string): Promise<void>;
  /** The link's target, or null when `link` is missing or is not a symlink. Never throws. */
  readlink(link: string): Promise<string | null>;
  unlink(link: string): Promise<void>;
}

export const nodeInstallFs: CliInstallFs = {
  mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
  symlink: (target, link) => symlink(target, link),
  readlink: (link) =>
    readlink(link).then(
      (value) => value,
      () => null,
    ),
  unlink: (link) => unlink(link),
};

export interface CliInstallDeps {
  home: string;
  /** The PATH the user's login shell exports (spec §4.6). A GUI app's own PATH is not what a terminal sees. */
  path: string;
  /** `AppPaths.cliBinary`. */
  target: string;
  fs: CliInstallFs;
  /**
   * Where an all-users install lives; defaults to `/usr/local/bin`. Injected so a test can exercise the all-users
   * branch -- including the `readlink` that `cliStatus` does on every call -- entirely inside a temp folder, instead
   * of reaching into a real system directory to decide what the Help menu says.
   */
  systemBinDir?: string;
  /**
   * Runs one privileged command. Supplied **only** for a deliberate all-users install; its absence is why the
   * default path can't escalate even by mistake.
   */
  escalate?(argv: string[]): Promise<void>;
}

export interface CliInstallStatus {
  installed: boolean;
  linkPath: string | null;
  onPath: boolean;
}

export interface CliInstallResult {
  ok: boolean;
  linkPath: string;
  onPath: boolean;
  message: string;
}

export function userBinDir(home: string): string {
  return join(home, USER_BIN_SUBPATH);
}

export function userLinkPath(home: string): string {
  return join(userBinDir(home), LINK_NAME);
}

function systemBinDirOf(deps: CliInstallDeps): string {
  return deps.systemBinDir ?? SYSTEM_BIN_DIR;
}

/** A PATH entry matches when it names the same folder, allowing a trailing slash and a `~` or `$HOME` prefix. */
export function isOnPath(path: string, dir: string, home: string): boolean {
  return path.split(":").some((entry) => {
    if (!entry) return false;
    const expanded = entry.startsWith("~/")
      ? join(home, entry.slice(2))
      : entry.startsWith("$HOME/")
        ? join(home, entry.slice(6))
        : entry;
    return expanded.replace(/\/+$/, "") === dir.replace(/\/+$/, "");
  });
}

/** Both scopes' folders, user first: status reports whichever link actually points at this build. */
function candidateDirs(deps: CliInstallDeps): string[] {
  return [userBinDir(deps.home), systemBinDirOf(deps)];
}

export async function cliStatus(deps: CliInstallDeps): Promise<CliInstallStatus> {
  for (const dir of candidateDirs(deps)) {
    const linkPath = join(dir, LINK_NAME);
    if ((await deps.fs.readlink(linkPath)) === deps.target) {
      return { installed: true, linkPath, onPath: isOnPath(deps.path, dir, deps.home) };
    }
  }
  return { installed: false, linkPath: null, onPath: false };
}

export async function installCli(deps: CliInstallDeps, scope: InstallScope): Promise<CliInstallResult> {
  if (scope === "allUsers") return installForAllUsers(deps);

  const dir = userBinDir(deps.home);
  const linkPath = userLinkPath(deps.home);
  const onPath = isOnPath(deps.path, dir, deps.home);
  const existing = await deps.fs.readlink(linkPath);
  if (existing === null && (await pathExists(linkPath))) {
    return {
      ok: false,
      linkPath,
      onPath,
      message: `${linkPath} already exists and isn't a symlink; remove it and try again.`,
    };
  }
  try {
    await deps.fs.mkdir(dir);
    // Replace our own (or a stale) link rather than failing with EEXIST; a real file was refused above.
    if (existing !== null) await deps.fs.unlink(linkPath);
    await deps.fs.symlink(deps.target, linkPath);
  } catch (error) {
    return { ok: false, linkPath, onPath, message: `Couldn't install jslab at ${linkPath}: ${String(error)}` };
  }
  return {
    ok: true,
    linkPath,
    onPath,
    message: onPath
      ? `jslab is installed at ${linkPath}.`
      : `jslab is installed at ${linkPath}, but ${dir} isn't on your PATH. Add this line to your shell profile:\n\n    export PATH="$HOME/.local/bin:$PATH"`,
  };
}

/**
 * Spec §16.1's "Install for all users". This is the **only** path that escalates, it is never a fallback from the
 * user-scope install, and it runs exactly one command with a fixed argv -- no shell, no interpolation.
 */
async function installForAllUsers(deps: CliInstallDeps): Promise<CliInstallResult> {
  const dir = systemBinDirOf(deps);
  const linkPath = join(dir, LINK_NAME);
  const onPath = isOnPath(deps.path, dir, deps.home);
  if (!deps.escalate) {
    return { ok: false, linkPath, onPath, message: "Installing for all users isn't available in this build." };
  }
  try {
    await deps.escalate(["/bin/ln", "-sfn", deps.target, linkPath]);
  } catch (error) {
    return { ok: false, linkPath, onPath, message: `Couldn't install jslab at ${linkPath}: ${String(error)}` };
  }
  return { ok: true, linkPath, onPath, message: `jslab is installed at ${linkPath}.` };
}

export async function uninstallCli(deps: CliInstallDeps): Promise<CliInstallResult> {
  const status = await cliStatus(deps);
  if (!status.installed || status.linkPath === null) {
    return { ok: true, linkPath: userLinkPath(deps.home), onPath: status.onPath, message: "jslab wasn't installed." };
  }
  const linkPath = status.linkPath;
  const privileged = linkPath === join(systemBinDirOf(deps), LINK_NAME);
  try {
    if (privileged) {
      if (!deps.escalate) {
        return { ok: false, linkPath, onPath: status.onPath, message: `Removing ${linkPath} needs an administrator.` };
      }
      await deps.escalate(["/bin/rm", "-f", linkPath]);
    } else {
      await deps.fs.unlink(linkPath);
    }
  } catch (error) {
    return { ok: false, linkPath, onPath: status.onPath, message: `Couldn't remove ${linkPath}: ${String(error)}` };
  }
  return { ok: true, linkPath, onPath: status.onPath, message: `jslab was removed from ${linkPath}.` };
}

async function pathExists(path: string): Promise<boolean> {
  return await Bun.file(path)
    .exists()
    .catch(() => false);
}
