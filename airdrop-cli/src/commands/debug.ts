import { Command, command, metadata, param } from "clime";
import { loadingBar } from "../utils";
import { parseDebugData } from "../utils/debug";

@command({
  brief: "Debug CLI data.",
  description: "Displays and processes the the available debug data.",
})
export default class extends Command {
  @metadata
  async execute(
    @param({
      description: "",
      required: false,
    })
    _: string
  ) {
    const loader = await loadingBar();

    await parseDebugData();

    clearInterval(loader);
  }
}
