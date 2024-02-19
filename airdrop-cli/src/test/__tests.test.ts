import Help from "../commands/help";
import Single from "../commands/single";
import Tally from "../commands/tally";

import fs from "fs";

/**

*/

describe("CLI Tests", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation();
  });

  const outputNames = ["all_repos_contributors.csv", "all_repos_decoded-permits.csv"];

  afterEach(async () => {
    jest.restoreAllMocks();
  });

  describe("Single", () => {
    jest.setTimeout(30000);
    it("should tally the UBQ airdrop for a single repo", async () => {
      expect(await new Single().execute(".github")).toBe(true);

      const doesExist = fs.existsSync(outputNames[1]);
      expect(doesExist).toBe(true);
    });
  });

  describe("Help", () => {
    it("should display the legend for the repository names", async () => {
      const help = new Help();
      const spy = jest.spyOn(console, "log").mockImplementation();
      await help.execute();

      expect(spy).toHaveBeenCalledWith("Key\tRepository");
      expect(spy).toHaveBeenCalledWith("===\t==========");
      expect(spy).toHaveBeenCalledWith("common\tuad-common-contracts-prototyping");
      expect(spy).toHaveBeenCalledWith("uad-de\tuad-debt-contracts-prototyping");
      expect(spy).toHaveBeenCalledWith("uad-bo\tuad-bonding-contracts-prototyping");
      expect(spy).toHaveBeenCalledWith("contra\tuad-contracts");

      spy.mockRestore();
    });
  });

  describe("Tally", () => {
    jest.setTimeout(90000);
    it("should tally the UBQ airdrop for all repos", async () => {
      expect(await new Tally().execute()).toBe(true);

      for (const name of outputNames) {
        // not all repos will return a file with data but a file should be created
        expect(fs.existsSync(name)).toBe(true);
      }
    });
  });
});
