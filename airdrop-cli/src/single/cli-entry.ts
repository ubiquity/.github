import { processRepo } from "../tally/tally";
import { genKeySet, loadingBar } from "../utils";

(async (key: string) => {
  const keySet = await genKeySet();

  const filtered = keySet.filter((k) => k.key === key || k.name === key);
  const loader = await loadingBar();

  for (const key of filtered) {
    await processRepo("Ubiquity", key.repo, false);
  }

  clearInterval(loader);
})(process.argv[2]);
