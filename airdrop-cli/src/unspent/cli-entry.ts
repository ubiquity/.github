import { Erc20Permit, processAllUnclaimedPermits } from "./index";
import fs from "fs";
import { loadingBar, writeToFile } from "../utils";

(async () => {
  const loader = await loadingBar();

  let permits: Erc20Permit[];

  try {
    const temp = fs.readFileSync("./debug/repos/decoded-permits.json", "utf8");
    permits = JSON.parse(temp);
  } catch (err) {
    console.log(err);
    throw new Error("ERROR: Have you run the 'cli:tally' command?");
  }

  const unspentPermits = await processAllUnclaimedPermits(permits);

  await writeToFile("./src/unspent/unspentPermits.json", JSON.stringify(unspentPermits, null, 2));

  clearInterval(loader);
})();
