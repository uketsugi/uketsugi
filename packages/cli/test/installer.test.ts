import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { tempDir } from "./support.ts";

const run = promisify(execFile);
const INSTALLER = fileURLToPath(new URL("../../../deploy/install.sh", import.meta.url));
/** The script installs the linux-x64 release and refuses any other machine before it does anything. */
const here = process.platform === "linux" && process.arch === "x64";

/** A tarball shaped like a release, whose `ukt` only says its version, and the tarball's SHA-256. */
async function fakeRelease(dir: string): Promise<{ file: string; sha256: string }> {
  const bin = join(dir, "uketsugi-0.0.0-linux-x64", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "ukt"), "#!/bin/sh\necho 0.0.0\n");
  await chmod(join(bin, "ukt"), 0o755);
  const file = join(dir, "release.tar.gz");
  await run("tar", ["-czf", file, "-C", dir, "uketsugi-0.0.0-linux-x64"]);
  return {
    file,
    sha256: createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  };
}

describe.runIf(here)("deploy/install.sh, as a person's first command", () => {
  test("says how to put the command on the PATH, for this shell and for new ones", async () => {
    const dir = await tempDir();
    const { file, sha256 } = await fakeRelease(dir);
    const home = join(dir, "home");
    await mkdir(home);
    const install = (shell: string) =>
      run("sh", [INSTALLER, "--tarball", file, "--sha256", sha256], {
        env: { HOME: home, PATH: "/usr/bin:/bin", SHELL: shell },
      });
    const bin = join(home, ".local", "bin");

    const { stdout } = await install("/usr/bin/zsh");
    expect(stdout).toContain(
      `Installed uketsugi 0.0.0 in ${join(home, ".local", "lib", "uketsugi")}`,
    );
    expect(stdout.split("\n").slice(-7, -1)).toEqual([
      `${bin} is not on your PATH. Add it for this shell:`,
      `  export PATH="${bin}:$PATH"`,
      "and for new ones:",
      `  echo 'export PATH="${bin}:$PATH"' >> ${home}/.zshrc`,
      "",
      `Next: ukt setup   (or now: ${bin}/ukt setup)`,
    ]);
    expect((await install("/bin/bash")).stdout).toContain(`>> ${home}/.bashrc`);
    expect((await install("/bin/dash")).stdout).toContain(`>> ${home}/.profile`);
    // With the directory on the PATH already there is nothing to add.
    const onPath = await run("sh", [INSTALLER, "--tarball", file, "--sha256", sha256], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
    });
    expect(onPath.stdout).not.toContain("PATH");
    expect(onPath.stdout.trimEnd().endsWith("Next: ukt setup")).toBe(true);
  });

  test("says what it is downloading before it downloads, so that a slow line does not look hung", async () => {
    const dir = await tempDir();
    const { file, sha256 } = await fakeRelease(dir);
    const tarball = await readFile(file);
    const server = createServer((_request, response) => response.end(tarball));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/release.tar.gz`;
    try {
      const { stdout, stderr } = await run(
        "sh",
        [INSTALLER, "--tarball", url, "--sha256", sha256],
        {
          env: { HOME: dir, PATH: "/usr/bin:/bin" },
        },
      );
      expect(stderr.split("\n")[0]).toBe(`Downloading uketsugi from ${url}`);
      expect(stdout).toContain("Installed uketsugi 0.0.0");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("read from a pipe, installs when its build was told where the release is served, and says why it cannot when not", async () => {
    const dir = await tempDir();
    const { file, sha256 } = await fakeRelease(dir);
    const tarball = await readFile(file);
    const server = createServer((_request, response) => response.end(tarball));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const served = `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases`;
    // The copy a build ships: the script with its release's name, checksum and address filled in.
    const built = async (url: string): Promise<string> =>
      (await readFile(INSTALLER, "utf8"))
        .replace(/^BUILT_TARBALL=.*$/m, 'BUILT_TARBALL="release.tar.gz"')
        .replace(/^BUILT_SHA256=.*$/m, `BUILT_SHA256="${sha256}"`)
        .replace(/^BUILT_URL=.*$/m, `BUILT_URL="${url}"`);
    /** `curl …/install.sh | sh`: the script arrives on standard input, beside no file. */
    const piped = (script: string, home: string) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const shell = spawn("sh", [], { env: { HOME: home, PATH: "/usr/bin:/bin" } });
        const out: string[] = [];
        const err: string[] = [];
        shell.stdout.on("data", (text: Buffer) => out.push(text.toString()));
        shell.stderr.on("data", (text: Buffer) => err.push(text.toString()));
        shell.on("close", (code) => resolve({ code, stdout: out.join(""), stderr: err.join("") }));
        shell.stdin.end(script);
      });
    try {
      const [withAddress, without] = [join(dir, "home-1"), join(dir, "home-2")];
      await mkdir(withAddress);
      await mkdir(without);

      const installed = await piped(await built(served), withAddress);
      expect(installed.stderr).toContain(`Downloading uketsugi from ${served}/release.tar.gz`);
      expect(installed.stdout).toContain("Installed uketsugi 0.0.0");
      expect(installed.code).toBe(0);

      const refused = await piped(await built(""), without);
      expect(refused.code).toBe(1);
      expect(refused.stderr.trim().split("\n")).toEqual([
        "install.sh: this copy of the install script was built without the address of its release, so it cannot fetch it.",
        "Nothing was installed. Put release.tar.gz in the folder this script is in and run it from there, or pass --tarball <file or URL>.",
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
