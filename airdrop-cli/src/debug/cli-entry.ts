import { loadingBar } from "../utils";
import { parseDebugData } from "../utils/debug";

(async () => {
  const loader = await loadingBar();

  await parseDebugData();

  clearInterval(loader);
})();
