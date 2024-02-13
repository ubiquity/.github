import { Command, command, metadata, param } from "clime";
import { processRepo } from "../invoke/invoke";
import { genKeySet, loadingBar } from "../utils";

@command({
  brief: "Process a single repository.",
  description: "Tally the UBQ airdrop for a single repository.",
})
export default class extends Command {
  @metadata
  async execute(
    @param({
      description: "The repository name or key.",
      required: false,
    })
    key: string
  ) {
    const keySet = await genKeySet();

    const filtered = keySet.filter((k) => k.key === key || k.name === key);
    const since = "2023-01-01T00:00:00.000Z";
    const loader = await loadingBar();

    for (const key of filtered) {
      await processRepo("Ubiquity", key.repo, since, false);
    }

    clearInterval(loader);
  }
}
