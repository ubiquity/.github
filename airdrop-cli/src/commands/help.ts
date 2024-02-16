import { Command, command, metadata } from "clime";
import { genKeySet } from "../utils";

@command({
  brief: "Display the legend for the repository names.",
  description: "Use any legend key like: ``yarn cli:single <key>``",
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
    const keySet = await genKeySet();

    console.log("Key\tRepository");
    console.log("===\t==========");
    for (const key of keySet) {
      console.log(`${key.key}\t${key.name}`);
    }
  }
}
