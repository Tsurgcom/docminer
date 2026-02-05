import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const isMainModule = (metaUrl: string): boolean => {
  if (!process.argv[1]) {
    return false;
  }

  const mainPath = resolve(process.argv[1]);
  const selfPath = fileURLToPath(metaUrl);

  return mainPath === selfPath;
};
