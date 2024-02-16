import { Command, command, metadata } from "clime";
import { invoke } from "../invoke/invoke";

// Tally command
// Takes around 1 minute to complete using async/await (rate limited using promises)

@command({
  brief: "Tally UBQ airdrop.",
  description: "Includes all public repository permits and payments, outputs to various CSV files. ",
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
    await invoke();
    return true;
  }
}
