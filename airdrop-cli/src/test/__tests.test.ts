import Help from "../commands/help";
import Single from "../commands/single";
import TallyFrom from "../commands/tally-from";
import Tally from "../commands/tally";

import fs from "fs";

/**
PASS  src/test/__tests.test.ts (92.531 s)
PASS  dist/test/__tests.test.js (96.143 s)

Test Suites: 2 passed, 2 total
Tests:       8 passed, 8 total
Snapshots:   0 total
Time:        96.562 s
Ran all test suites.
Done in 98.47s.
*/

describe("CLI Tests", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    const outputNames = [
      "all_repos_all_payments.csv",
      "all_repos_contributors.csv",
      "all_repos_no_payments.csv",
    ];

    for (const name of outputNames) {
      const path = `./${name}`;
      const exists = fs.existsSync(path);
      if (exists) {
        await fs.promises.unlink(path);
      }
    }
  });

  describe("Single", () => {
    jest.setTimeout(7000);
    it("should tally the UBQ airdrop for a single repo", async () => {
      const single = new Single();
      const repo = ".github";
      await single.execute(repo);

      const outputNames = [
        "all_repos_all_payments.csv",
        "all_repos_contributors.csv",
        "all_repos_no_payments.csv",
      ];

      for (const name of outputNames) {
        const path = `./${name}`;
        const exists = fs.existsSync(path);
        expect(exists).toBe(true);

        if (exists) {
          const data = fs.readFileSync(path, "utf8");

          const lines = data.split("\n");
          lines.shift();
          if (name === "all_repos_all_payments.csv") {
            expect(lines.length).toBeGreaterThan(0);
          } else if (name === "all_repos_contributors.csv") {
            expect(lines.length).toBeGreaterThan(0);
          } else {
            expect(lines.length).toBe(1);
            expect(lines[0]).toBe("");

            await fs.promises.unlink(path);
          }
        }
      }
    });
  });

  describe("Help", () => {
    it("should display the legend for the repository names", async () => {
      const help = new Help();
      const spy = jest.spyOn(console, "log").mockImplementation();
      await help.execute();

      expect(spy).toHaveBeenCalledWith("Key\tRepository");
      expect(spy).toHaveBeenCalledWith("===\t==========");
      expect(spy).toHaveBeenCalledWith(
        "common\tuad-common-contracts-prototyping"
      );
      expect(spy).toHaveBeenCalledWith(
        "uad-de\tuad-debt-contracts-prototyping"
      );
      expect(spy).toHaveBeenCalledWith(
        "uad-bo\tuad-bonding-contracts-prototyping"
      );
      expect(spy).toHaveBeenCalledWith("contra\tuad-contracts");

      spy.mockRestore();
    });
  });

  describe("TallyFrom", () => {
    jest.setTimeout(50000);
    it("should tally the UBQ airdrop from a given date", async () => {
      const tallyFrom = new TallyFrom();
      const date = "2045-01-01";
      console.log("date", date);
      await tallyFrom.execute(date);

      const outputNames = [
        "all_repos_all_payments.csv",
        "all_repos_contributors.csv",
        "all_repos_no_payments.csv",
      ];

      for (const name of outputNames) {
        const path = `./${name}`;
        const exists = fs.existsSync(path);
        expect(exists).toBe(true);

        if (exists) {
          const data = fs.readFileSync(path, "utf8");

          if (name === "all_repos_no_payments.csv") {
            const lines = data.split("\n");
            lines.shift();
            expect(lines.length).toBeGreaterThanOrEqual(51);
          } else {
            const lines = data.split("\n");
            lines.shift();
            expect(lines.length).toBe(1);
            expect(lines[0]).toBe("");
          }
          // await fs.promises.unlink(path);
        }
      }
    });
  });

  describe("Tally", () => {
    jest.setTimeout(150000);
    it("should tally the UBQ airdrop for all repos", async () => {
      const tally = new Tally();
      await tally.execute();

      const outputNames = [
        "all_repos_all_payments.csv",
        "all_repos_contributors.csv",
        "all_repos_no_payments.csv",
      ];

      for (const name of outputNames) {
        const path = `./${name}`;
        const exists = fs.existsSync(path);
        expect(exists).toBe(true);

        if (exists) {
          const data = fs.readFileSync(path, "utf8");

          const lines = data.split("\n");
          lines.shift();

          expect(lines.length).toBeGreaterThan(4);

          await fs.promises.unlink(path);
        }
      }
    });
  });
});
