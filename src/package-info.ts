import { createRequire } from "node:module";

type PackageJson = {
  version?: string;
};

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as PackageJson;

export const packageVersion = packageJson.version ?? "0.0.0";
