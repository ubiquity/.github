import { Command, command, metadata } from "clime";
import { loadingBar, writeToFile } from "../utils";
import { Erc20Permit, processAllUnclaimedPermits } from "../unspent";
import fs from "fs";

@command({
  brief: "Gathers unspent permits",
  description: "Gathers unspent permits and outputs to a json file. Find yours with CTRL + F",
})
export default class extends Command {
  /**
   * As TypeScript only emits metadata for target decorated by decorators,
   * if no command-line parameter is added then Clime won't know information of options and context parameter.
   * Thus a @metadata decorator that does nothing at run time is provided for preserving these metadata
   * It is required to have this @metadata decorator if no other decorator is applied to method execute.
   */
  @metadata
  async execute() {
    let permits: Erc20Permit[];
    const loader = await loadingBar();

    try {
      const temp = fs.readFileSync("./debug/repos/decoded-permits.json", "utf8");
      permits = JSON.parse(temp);
    } catch (err) {
      console.log(err);
      throw new Error("ERROR: Have you run the 'cli:tally' command?");
    }

    if (!permits || permits.length === 0) {
      throw new Error("The data for processing is empty. Try running the 'cli:tally' command first.");
    }

    const processed = await processAllUnclaimedPermits(permits);
    await writeToFile("./src/unspent/unspentPermits.json", JSON.stringify(processed, null, 2));

    clearInterval(loader);
  }
}
