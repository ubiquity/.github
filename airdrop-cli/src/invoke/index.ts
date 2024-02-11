import * as dotenv from "dotenv";
import { request, gql } from "graphql-request";
import { loadingBar, writeCSV } from "../utils";
import {
  Repositories,
  PaymentInfo,
  NoPayments,
  Contributor,
  CSVData,
} from "../types";

dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";

export async function invoke(timeFrom?: string) {
  const org = "Ubiquity";
  const since = "2023-01-01T00:00:00.000Z";
  const loader = await loadingBar();

  const data: CSVData | undefined = await processRepositories(
    org,
    timeFrom ? timeFrom : since
  );

  if (!data) {
    throw new Error("No data found processing all repositories.");
  }

  await writeCSV(data);

  clearInterval(loader);
}

export async function fetchPublicRepositories(
  org: string = "Ubiquity",
  repo?: string
): Promise<Repositories[]> {
  let hasNextPage = true;
  let cursor = null;
  const repositories: Repositories[] = [];

  const query = gql`
    query ($org: String!, $cursor: String) {
      organization(login: $org) {
        repositories(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              name
              isArchived
              defaultBranchRef {
                target {
                  ... on Commit {
                    history(first: 1) {
                      edges {
                        node {
                          committedDate
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  while (hasNextPage) {
    const response: any = await request(
      GITHUB_GRAPHQL_API,
      query,
      { org, cursor },
      { Authorization: `Bearer ${GITHUB_TOKEN}` }
    );

    const repos = response.organization.repositories.edges;

    for (const repo of repos) {
      const repoInfo = repo.node;
      const lastCommitDate =
        repoInfo.defaultBranchRef?.target?.history.edges.length > 0
          ? repoInfo.defaultBranchRef.target.history.edges[0].node.committedDate
          : null;

      repositories.push({
        name: repoInfo.name,
        isArchived: repoInfo.isArchived,
        lastCommitDate: lastCommitDate,
      });
    }

    const pageInfo = response.organization.repositories.pageInfo;
    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  if (repo) {
    return repositories.filter((r) => r.name === repo);
  }

  return repositories;
}

// Fetch payments for a single repository
export async function fetchPaymentsForRepository(
  org: string,
  repoName: string,
  since: string
): Promise<{ payments: PaymentInfo[]; noAssigneePayments: PaymentInfo[] }> {
  let hasNextPage = true;
  let cursor = null;
  const payments = new Set<PaymentInfo>();
  const noAssigneePayments = new Set<PaymentInfo>();

  const query = gql`
    query (
      $org: String!
      $repoName: String!
      $cursor: String
      $since: DateTime
    ) {
      repository(owner: $org, name: $repoName) {
        issues(first: 100, after: $cursor, filterBy: { since: $since }) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              number
              author {
                login
              }
              assignees(first: 1) {
                edges {
                  node {
                    login
                  }
                }
              }
              comments(first: 100) {
                edges {
                  node {
                    body
                    author {
                      login
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  while (hasNextPage) {
    const response: any = await request(
      GITHUB_GRAPHQL_API,
      query,
      { org, repoName, cursor, since },
      { Authorization: `Bearer ${GITHUB_TOKEN}` }
    );

    for (const issue of response.repository.issues.edges) {
      const issueNumber = issue.node.number;
      const issueCreator = issue.node.author?.login;

      // Issues without an assignee are typically issues reopened or edge cases
      const issueAssignee =
        issue.node.assignees.edges.length > 0
          ? issue.node.assignees.edges[0].node?.login
          : "No assignee";

      /**
       * the below works well enough but it's incorrectly assigning the occasional payment
       * cases which I've seen:
       * - New assignee on an issue that has already been paid out
       *   see: https://github.com/Ubiquity/research/issues/40
       *   200 paid to hodl but pav is now the assigned so it's been assigned to pav in this particular case
       *
       * - Payments that have been redacted and added as a debt on their next payment
       *   see: https://github.com/Ubiquity/business-development/issues/38
       *   300 paid to hodl but 300 debt added
       *
       * - deleted GH accounts see: @AnakinSkywalker who is now @Ghost
       *
       * Will need to think about how to handle these cases and try to make this more robust
       */

      for (const comment of issue.node.comments.edges) {
        const body = comment.node.body;

        // Match: [ CLAIM 12.5 DAI ] typically the assignee's award
        const match = body.match(
          /.*\[ CLAIM (\d+(\.\d+)?) (XDAI|DAI|WXDAI) \]/
        );

        // Match: [ **[ 12.5 DAI ]] typically the newer <details> type awards
        const altMatch = body.match(
          /.*\[ \[ \*?(\d+(\.\d+)?) \*?(XDAI|DAI|WXDAI)\*? \]\]/
        );

        /**
         * Most of the time the awards are in the format:
         * Assignee >>: ### [ **[ CLAIM 25 WXDAI ],25,,WXDAI
         * Convo|Creator >>: ### [ **gitcoindev: [ CLAIM 18.6 WXDAI ],18.6,.6,WXDAI
         * Assignee >>: ### [ **[ CLAIM 25 WXDAI ],25,,WXDAI
         * Convo|Creator >>: ### [ **rndquu: [ CLAIM 23.4 WXDAI ],23.4,.4,WXDAI
         */

        // we catch all payment comments here then filter them out
        if (match) {
          const rematch = body.match(/CLAIM (\d+(\.\d+)?) (XDAI|DAI|WXDAI)/);
          const creator = body.includes("Task Creator Reward") ? true : false;
          const conversation = body.includes("Conversation Reward")
            ? true
            : false;

          // comments around the start of 2023 do not have creator/conversation prefixes
          // but those types of comments were not introduced until the end of 2023
          // so we're best guessing they are creator rewards

          const type = creator
            ? "creator"
            : conversation
            ? "conversation"
            : "assignee";

          if (
            body.includes(`: [ CLAIM`) &&
            comment.node.author?.login === "ubiquibot"
          ) {
            // this should be either the creator's or conversation awards as they are named
            // the only time this rule breaks is the <details> type awards and the assignee is named too
            // although the claim format is different 'gitcoindev: [ CLAIM 18.6 WXDAI ]' vs '[ [ 18.6 WXDAI ] ]'

            let user = body.split(":")[0];

            if (user.includes("**")) {
              // seen in various award formats
              user = user.split("**")[1];
            } else if (user.includes("###")) {
              // seen in the newer <details> type awards
              user = user.split("###")[1];
            }

            payments.add({
              repoName,
              issueNumber,
              paymentAmount: parseFloat(rematch[1]),
              currency: rematch[3],
              payee: user,
              type,
              url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
            });

            if (user === "No assignee") {
              noAssigneePayments.add({
                repoName,
                issueNumber,
                paymentAmount: parseFloat(rematch[1]),
                currency: rematch[3],
                payee: user,
                type,
                url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
              });
            }
          } else {
            // if we are here then it is the assignee's award

            if (rematch && comment.node.author?.login === "ubiquibot") {
              payments.add({
                repoName,
                issueNumber,
                paymentAmount: parseFloat(rematch[1]),
                currency: rematch[3],
                payee: issueAssignee,
                type,
                url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
              });

              if (issueAssignee === "No assignee") {
                noAssigneePayments.add({
                  repoName,
                  issueNumber,
                  paymentAmount: parseFloat(rematch[1]),
                  currency: rematch[3],
                  payee: issueAssignee,
                  type,
                  url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
                });
              }
            }
          }
          continue;
        }

        if (altMatch && comment.node.author?.login === "ubiquibot") {
          // this is the newer <details> type awards
          const users = altMatch.input
            .match(/###### @\w+/g)
            .map((user: string) => user.split(" ")[1]);

          // multiple payouts so pulling them both out
          const payouts = altMatch.input.match(
            /\*?(\d+(\.\d+)?) \*?(XDAI|DAI|WXDAI)\*?/g
          );

          for (const user of users) {
            let usr = user.split("@")[1];

            const assigneeReward = issueAssignee === usr;
            const creatorReward = issueCreator === usr;
            const type = assigneeReward
              ? "assignee"
              : creatorReward
              ? "creator"
              : "conversation";

            payments.add({
              repoName,
              issueNumber,
              paymentAmount: parseFloat(
                payouts[users.indexOf(user)].split(" ")[0]
              ),
              currency: payouts[users.indexOf(user)].split(" ")[1],
              payee: usr,
              type,
              url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
            });

            if (usr === "No assignee") {
              noAssigneePayments.add({
                repoName,
                issueNumber,
                paymentAmount: parseFloat(altMatch[1]),
                currency: altMatch[3],
                payee: usr,
                type,
                url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
              });
            }
          }
          continue;
        }

        if (match) {
          // haven't hit this yet but here for debugging
          console.log(`still matching: `, match);
        }

        if (altMatch) {
          // this is the details awards still, fsr it's not catching the bot as the author here
          // but matches without the bot as the author. I've only seen this once so far
          // https://github.com/ubiquity/ubiquibot-kernel/issues/5#issuecomment-1923562557

          const users = altMatch.input
            .match(/###### @\w+/g)
            .map((user: string) => user.split(" ")[1]);

          const payouts = altMatch.input.match(
            /\*?(\d+(\.\d+)?) \*?(XDAI|DAI|WXDAI)\*?/g
          );

          for (const user of users) {
            let usr = user.split("@")[1];

            const assigneeReward = issueAssignee === usr;
            const creatorReward = issueCreator === usr;
            const type = assigneeReward
              ? "assignee"
              : creatorReward
              ? "creator"
              : "conversation";

            payments.add({
              repoName,
              issueNumber,
              paymentAmount: parseFloat(
                payouts[users.indexOf(user)].split(" ")[0]
              ),
              currency: payouts[users.indexOf(user)].split(" ")[1],
              payee: usr,
              type,
              url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
            });

            if (usr === "No assignee") {
              noAssigneePayments.add({
                repoName,
                issueNumber,
                paymentAmount: parseFloat(altMatch[1]),
                currency: altMatch[3],
                payee: usr,
                type,
                url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
              });
            }
          }
          continue;
        }
      }
    }

    hasNextPage = response.repository.issues.pageInfo.hasNextPage;
    cursor = response.repository.issues.pageInfo.endCursor;
  }

  const data = {
    payments: Array.from(payments),
    noAssigneePayments: Array.from(noAssigneePayments),
  };

  return data;
}

// Process a single repository for payment comments in [CLOSED, OPEN] issues
export async function processRepo(
  org: string,
  repo: Repositories,
  since: string,
  oneCsv: boolean
) {
  console.log(`Processing ${repo.name}...\n`);
  const allPayments: PaymentInfo[] = [];
  const allNoAssigneePayments: PaymentInfo[] = [];
  const noPayments: NoPayments[] = [];
  const contributors: Contributor = {};
  const payments = await fetchPaymentsForRepository(org, repo.name, since);

  if (payments.payments.length === 0) {
    noPayments.push({
      repoName: repo.name,
      archived: repo.isArchived,
      lastCommitDate: repo.lastCommitDate,
      message: "No payments found",
      url: `https://github.com/${org}/${repo.name}`,
    });
  }

  allPayments.push(...payments.payments);
  allNoAssigneePayments.push(...payments.noAssigneePayments);

  for (const payment of allPayments) {
    const username = payment.payee;
    if (username) {
      if (contributors[username]) {
        contributors[username] += payment.paymentAmount;
      } else {
        contributors[username] = payment.paymentAmount;
      }
    }
  }

  if (!oneCsv) {
    // called only when invoking the `single` command
    await writeCSV({
      contributors,
      allPayments,
      allNoAssigneePayments,
      noPayments,
    });
    return;
  } else {
    return {
      repo,
      contributors,
      allPayments,
      allNoAssigneePayments,
      noPayments,
    };
  }
}

// Process all repositories for payment comments in [CLOSED, OPEN] issues
export async function processRepositories(
  org: string,
  since: string
): Promise<CSVData | undefined> {
  const repos = await fetchPublicRepositories(org);

  const processedRepos: CSVData = {
    contributors: {},
    allPayments: [],
    allNoAssigneePayments: [],
    noPayments: [],
  };

  for (const repo of repos) {
    const processed = await processRepo(org, repo, since, true);
    if (!processed) {
      console.log(`No data for ${repo.name}`);
      continue;
    }

    processedRepos.allPayments.push(...processed.allPayments);
    processedRepos.noPayments.push(...processed.noPayments);

    for (const [username, balance] of Object.entries(processed.contributors)) {
      if (processedRepos.contributors[username]) {
        processedRepos.contributors[username] += balance;
      } else {
        processedRepos.contributors[username] = balance;
      }
    }

    processedRepos.allNoAssigneePayments.push(
      ...processed.allNoAssigneePayments
    );
  }

  return processedRepos;
}
