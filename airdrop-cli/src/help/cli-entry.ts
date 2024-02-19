import { genKeySet } from "../utils";

(async () => {
  const keySet = await genKeySet();

  console.log("Key\tRepository");
  console.log("===\t==========");
  for (const key of keySet) {
    console.log(`${key.key}\t${key.name}`);
  }
})();
