import { Command, command, metadata, param } from "clime";
import { genKeySet } from "../utils";

@command({
  brief: "Display the legend for the repository names.",
  description:
    "Use any legend key like: ``yarn single <key>`` to filter the repositories by the first letter of the name.",
})
export default class extends Command {
  @metadata
  async execute(
    @param({
      description: "The repository name",
      required: false,
    })
    _orgName?: string
  ) {
    const keySet = await genKeySet();

    console.log("Key\tRepository");
    console.log("===\t==========");
    for (const key of keySet) {
      console.log(`${key.key}\t${key.name}`);
    }

    return;
  }
}
