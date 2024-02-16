import { Command, command, metadata } from "clime";
import { loadingBar } from "../utils";
import { parseDebugData } from "../utils/debug";

@command({
  brief: "Debug CLI data.",
  description: "Displays and processes the the available debug data.",
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
    const loader = await loadingBar();

    await parseDebugData();

    clearInterval(loader);
  }
}
