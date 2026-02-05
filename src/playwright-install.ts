import { spawn } from "node:child_process";

const isBunRuntime = (): boolean =>
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ||
  typeof process.versions.bun === "string";

const buildInstallArgs = (extraArgs: string[]): string[] => {
  const baseArgs = ["install"];
  const hasWithDeps = extraArgs.includes("--with-deps");
  if (hasWithDeps) {
    return baseArgs.concat(extraArgs);
  }
  return baseArgs.concat(["--with-deps"], extraArgs);
};

export async function runPlaywrightInstall(extraArgs: string[]): Promise<void> {
  const runner = isBunRuntime() ? "bunx" : "npx";
  const args = ["playwright", ...buildInstallArgs(extraArgs)];
  const command = `${runner} ${args.join(" ")}`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, { stdio: "inherit", shell: true });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Playwright install failed with exit code ${code}`));
    });
  });
}
