import { invoke } from "./invoke";

async function main() {
  await invoke();
}

main().catch(console.error);
