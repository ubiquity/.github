import { Command, command, metadata } from "clime";
import { genKeySet } from "../utils";

@command({
  brief: "Display the legend for the repository names.",
  description: "Use any legend key like: ``yarn cli:single <key>``",
})
export default class extends Command {
  @metadata
  async execute() {
    const keySet = await genKeySet();

    console.log("Key\tRepository");
    console.log("===\t==========");
    for (const key of keySet) {
      console.log(`${key.key}\t${key.name}`);
    }
  }
}
