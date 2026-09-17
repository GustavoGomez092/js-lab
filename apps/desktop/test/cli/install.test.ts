import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliStatus, installCli, isOnPath, nodeInstallFs, uninstallCli, userLinkPath } from "../../src/main/cli/install";

let home = "";
let target = "";
/**
 * A stand-in for `/usr/local/bin`, inside the temp home. `systemBinDir` exists so that even the all-users
 * *reads* in these tests stay in the sandbox: nothing here touches a real system folder.
 */
let sysBin = "";
let sysLink = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jslab-home-"));
  target = join(home, "app", "bin", "jslab");
  sysBin = join(home, "fake-usr-local-bin");
  sysLink = join(sysBin, "jslab");
  await Bun.write(target, "#!/bin/sh\n");
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** The real fs, a temp home, and deliberately no `escalate`: nothing here can reach osascript. */
const deps = (path: string) => ({ home, path, target, fs: nodeInstallFs });

describe("the jslab install", () => {
  test("creates ~/.local/bin and links the binary there, with no escalation", async () => {
    const result = await installCli(deps(`${home}/.local/bin:/usr/bin`), "user");
    expect(result).toEqual({
      ok: true,
      linkPath: userLinkPath(home),
      onPath: true,
      message: `jslab is installed at ${userLinkPath(home)}.`,
    });
    expect(await readlink(userLinkPath(home))).toBe(target);
  });

  test("a PATH without the folder still installs, and says exactly what to add (§16.1)", async () => {
    const result = await installCli(deps("/usr/bin:/bin"), "user");
    expect(result.ok).toBe(true);
    expect(result.onPath).toBe(false);
    expect(result.message).toBe(
      `jslab is installed at ${userLinkPath(home)}, but ${join(home, ".local", "bin")} isn't on your PATH. ` +
        `Add this line to your shell profile:\n\n    export PATH="$HOME/.local/bin:$PATH"`,
    );
  });

  test("re-installing over an existing link replaces it rather than failing", async () => {
    await installCli(deps("/usr/bin"), "user");
    const moved = join(home, "app", "bin", "jslab2");
    await Bun.write(moved, "#!/bin/sh\n");
    const result = await installCli({ ...deps("/usr/bin"), target: moved }, "user");
    expect(result.ok).toBe(true);
    expect(await readlink(userLinkPath(home))).toBe(moved);
  });

  test("a real file in the way is refused rather than deleted", async () => {
    const link = userLinkPath(home);
    await nodeInstallFs.mkdir(join(home, ".local", "bin"));
    await writeFile(link, "someone else's jslab");
    const result = await installCli(deps("/usr/bin"), "user");
    expect(result.ok).toBe(false);
    expect(result.message).toBe(`${link} already exists and isn't a symlink; remove it and try again.`);
    expect(await Bun.file(link).text()).toBe("someone else's jslab");
  });

  test("an install that can't be written reports the failure instead of claiming success", async () => {
    const result = await installCli(
      {
        ...deps("/usr/bin"),
        fs: {
          ...nodeInstallFs,
          mkdir: async () => {
            throw new Error("EACCES: permission denied");
          },
        },
      },
      "user",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toStartWith(`Couldn't install jslab at ${userLinkPath(home)}: `);
    expect(result.message).toContain("EACCES: permission denied");
  });

  test("status reports whether the link exists and whether it is findable", async () => {
    expect(await cliStatus(deps("/usr/bin"))).toEqual({ installed: false, linkPath: null, onPath: false });
    await installCli(deps(`${home}/.local/bin`), "user");
    expect(await cliStatus(deps(`${home}/.local/bin`))).toEqual({
      installed: true,
      linkPath: userLinkPath(home),
      onPath: true,
    });
  });

  test("status ignores a symlink that points somewhere else entirely", async () => {
    await nodeInstallFs.mkdir(join(home, ".local", "bin"));
    await symlink("/usr/bin/true", userLinkPath(home));
    expect(await cliStatus(deps("/usr/bin"))).toMatchObject({ installed: false });
  });

  test("status also finds an all-users link, reported at its own path", async () => {
    await nodeInstallFs.mkdir(sysBin);
    await symlink(target, sysLink);
    expect(await cliStatus({ ...deps(sysBin), systemBinDir: sysBin })).toEqual({
      installed: true,
      linkPath: sysLink,
      onPath: true,
    });
  });

  test("uninstall removes the link and reports it", async () => {
    await installCli(deps("/usr/bin"), "user");
    const result = await uninstallCli(deps("/usr/bin"));
    expect(result.ok).toBe(true);
    expect(result.message).toBe(`jslab was removed from ${userLinkPath(home)}.`);
    expect(await cliStatus(deps("/usr/bin"))).toMatchObject({ installed: false });
  });

  test("uninstalling when nothing is installed says so instead of failing", async () => {
    const result = await uninstallCli(deps("/usr/bin"));
    expect(result).toMatchObject({ ok: true, message: "jslab wasn't installed." });
  });

  test("removing an all-users link refuses without an escalation hook, and uses one rm with it", async () => {
    await nodeInstallFs.mkdir(sysBin);
    await symlink(target, sysLink);
    const refused = await uninstallCli({ ...deps("/usr/bin"), systemBinDir: sysBin });
    expect(refused).toMatchObject({ ok: false, message: `Removing ${sysLink} needs an administrator.` });
    // The link is still there: a refusal must not have half-removed it.
    expect(await readlink(sysLink)).toBe(target);

    const escalate = mock(async (_argv: string[]) => {});
    const removed = await uninstallCli({ ...deps("/usr/bin"), systemBinDir: sysBin, escalate });
    expect(removed).toMatchObject({ ok: true, message: `jslab was removed from ${sysLink}.` });
    expect(escalate.mock.calls).toEqual([[["/bin/rm", "-f", sysLink]]]);
  });

  test("all-users install never escalates on its own: without an escalation hook it refuses", async () => {
    const result = await installCli(deps("/usr/bin"), "allUsers");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Installing for all users isn't available in this build.");
  });

  test("all-users install runs exactly one privileged command, and only when asked for", async () => {
    const escalate = mock(async (_argv: string[]) => {});
    const result = await installCli({ ...deps("/usr/local/bin"), escalate }, "allUsers");
    expect(result).toMatchObject({ ok: true, linkPath: "/usr/local/bin/jslab", onPath: true });
    expect(escalate.mock.calls).toEqual([[["/bin/ln", "-sfn", target, "/usr/local/bin/jslab"]]]);
    // The user-scope install is untouched by it, which is what keeps the default path escalation-free.
    expect(await cliStatus(deps("/usr/bin"))).toMatchObject({ installed: false });
  });
});

describe("isOnPath", () => {
  test("matches an entry exactly, including a trailing slash, and expands a leading ~", () => {
    expect(isOnPath("/a:/h/.local/bin:/b", "/h/.local/bin", "/h")).toBe(true);
    expect(isOnPath("/a:/h/.local/bin/:/b", "/h/.local/bin", "/h")).toBe(true);
    expect(isOnPath("/a:~/.local/bin:/b", "/h/.local/bin", "/h")).toBe(true);
    expect(isOnPath("/a:$HOME/.local/bin:/b", "/h/.local/bin", "/h")).toBe(true);
    expect(isOnPath("/a:/h/.local/binary:/b", "/h/.local/bin", "/h")).toBe(false);
    expect(isOnPath("", "/h/.local/bin", "/h")).toBe(false);
  });
});
