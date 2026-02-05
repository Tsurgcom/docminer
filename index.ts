import { main } from "./src/cli";
import { isMainModule } from "./src/runtime";

if (isMainModule(import.meta.url)) {
  main();
}
