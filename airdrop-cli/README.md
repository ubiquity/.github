# UBQ Airdrop Tally Tool

## Overview
This CLI tool tallies UBQ airdrop amounts for contributors. It does this by parsing issue comments for payout links from the UBQ bot using the GitHub GraphQL API.

## Setup
1. **GitHub Token**
    - Add the token to ``.env`` as `GITHUB_TOKEN`.
2. **Install Dependencies**
    - Install the required dependencies using `npm` as yarn has issues with the graphql package.

    ```bash
    # npm install
    ```
3. **Build the CLI**
    - Build the CLI using the available commands.

    ```bash
    # npm run build
    ```

4. **Run the CLI**
    - Run the CLI using the available commands.

    ```bash
    # npm run start
    ```

## Commands
1. **start**
    - Display information about the available commands and their usage.

    ```bash
    # yarn start
    ```

2. **single**
    - Tally UBQ airdrop for a specific repository or shortcode from the beginning of 2023.

    ```bash
    # yarn single [shortcode/repo-name]
    ```

3. **tally**
    - Tally UBQ airdrop for all indexable repositories since the start of 2023.

    ```bash
    # yarn tally
    ```

4. **tally-from**
    - Tally UBQ airdrop for all indexable repositories since a specified date (YYYY-MM-DD).

    ```bash
    # yarn tally-from [date]
    ```

5. **tally-multi-csv**
    - Tally UBQ airdrop for all indexable repositories since the start of 2023 and output repository-specific CSV files.

    ```bash
    # yarn tally-multi-csv
    ```

6. **help**
    - Display a list of indexable repositories and their shortcodes.

    ```bash
    # yarn run help
    ```

## Output
The CLI outputs three CSV files:

1. [**All Payments**](all_repos_all_payments.csv)
    - Includes payments with or without an assignee. Manual checking required for entries without an assignee which is often due to issues having been reopened or manual payouts because of issues with the bot.

2. [**Contributors**](all_repos_contributors.csv)
    - Provides a username-to-UBQ mapping for total UBQ earned from all payments across all repositories since the chosen time.

3. [**No Payments**](all_repos_no_payments.csv)
    - Lists repositories that have been indexed as having no payments released, including archived and inactive repositories. Manual checking may be required.
   

## Usage Examples
1. Tally UBQ airdrop for a specific repository or shortcode:

    ```bash
    # npm run single dollar || npm single ubiquity-dollar
    ```

2. Tally UBQ airdrop for all indexable repositories since the start of 2023:

    ```bash
    # npm run tally
    ```

3. Tally UBQ airdrop for all indexable repositories since a specified date:

    ```bash
    # npm run tally-from 2023-01-01
    ```
4. Tally UBQ airdrop for all indexable repositories since the start of 2023 and output repository-specific CSV files:

    ```bash
    # npm run tally-multi-csv
    ```
5. Display a list of indexable repositories and their shortcodes:

    ```bash
    # npm run help
    ```