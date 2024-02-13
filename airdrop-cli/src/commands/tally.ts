import { Command, command, metadata } from "clime";
import { invoke } from "../invoke/invoke";

// Tally command
// Takes around 1 minute to complete using async/await (rate limited using promises)

@command({
  brief: "Tally UBQ airdrop.",
  description: "Includes all repositories with payments on dev branch since 01-01-2023.",
})
export default class extends Command {
  @metadata
  async execute() {
    await invoke();
  }
}
