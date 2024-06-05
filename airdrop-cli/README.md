# UBQ Airdrop Tally Tool

## Overview

This tool is designed to tally up Ubiquity contributor permits from across all issues and create a verifiable leaderboard based on earnings from completed tasks, ensuring a high level of data integrity and transparency.

A huge improvement from the first iteration of the airdrop tally tool, this is expected to store the underlying data into the `Permits` table in the database, which would render the need for future use of this tool obsolete.

## Usage

1. Install dependencies

```bash
yarn install
```

2. Open three terminals and run one parser in each terminal

```bash
yarn dune
```

```bash
yarn issue
```

```bash
yarn userTx
```

##### Note: This will take around 10-15 minutes to complete the process.

3. Close all but one terminal and run the following command

```bash
yarn all
```

## Changes Made

- Optimized and refactored the core `tally` function into a far more readable codebase.
- Created a parser for both blockscan APIs and Dune Analytics.
- Improved data integrity and cohesion of data from all sources as opposed to the previous version, through multiple parsers, checks and rechecks as well as outputting debug data/verification data that is much more workable.
- Combined all data available for a given permit into a single source of truth, handy for attributing permits to the respective issues (should the DB be extended to support that)
- Geared the tool towards seeding the database as opposed to outputting CSV files.
- Removed the unnecessary CLIME and CLI code, as it was never used in the first place.
