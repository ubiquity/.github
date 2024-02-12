import * as dotenv from "dotenv";
import { request, gql } from "graphql-request";
import { dataToCSV, loadingBar, removeDuplicates, writeCSV, writeToFile } from "../utils";
import { Repositories, PaymentInfo, NoPayments, Contributor, CSVData, DebugData, Permits } from "../types";

dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";

export async function invoke(timeFrom?: string) {
  const org = "Ubiquity";
  const since = "2023-01-01T00:00:00.000Z";
  const loader = await loadingBar();

  const data: CSVData | undefined = await processRepositories(org, timeFrom ? timeFrom : since);

  if (!data) {
    throw new Error("No data found processing all repositories.");
  }

  await writeCSV(data);

  clearInterval(loader);
}

export async function fetchPublicRepositories(org: string = "Ubiquity", repo?: string): Promise<Repositories[]> {
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
    const response: any = await request(GITHUB_GRAPHQL_API, query, { org, cursor }, { Authorization: `Bearer ${GITHUB_TOKEN}` });

    const repos = response.organization.repositories.edges;

    for (const repo of repos) {
      const repoInfo = repo.node;
      const lastCommitDate =
        repoInfo.defaultBranchRef?.target?.history.edges.length > 0 ? repoInfo.defaultBranchRef.target.history.edges[0].node.committedDate : null;

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
): Promise<{ payments: PaymentInfo[]; noAssigneePayments: PaymentInfo[]; debugData: DebugData[]; permits: Permits[] }> {
  let hasNextPage = true;
  let cursor = null;
  const payments = new Set<PaymentInfo>();
  const noAssigneePayments = new Set<PaymentInfo>();
  const debugData: DebugData[] = [];
  const permits: Permits[] = [];

  const query = gql`
    query ($org: String!, $repoName: String!, $cursor: String) {
      repository(owner: $org, name: $repoName) {
        issues(first: 100, after: $cursor) {
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
    const response: any = await request(GITHUB_GRAPHQL_API, query, { org, repoName, cursor, since }, { Authorization: `Bearer ${GITHUB_TOKEN}` });

    for (const issue of response.repository.issues.edges) {
      const issueNumber = issue.node.number;
      const issueCreator = issue.node.author?.login;

      // Issues without an assignee are typically issues reopened or edge cases
      const issueAssignee = issue.node.assignees.edges.length > 0 ? issue.node.assignees.edges[0].node?.login : "No assignee";

      for (const comment of issue.node.comments.edges) {
        const body = comment.node.body;

        const match = body.match(/\*\*CLAIM (\d+(\.\d+)?) (XDAI|DAI|WXDAI)\*\*/g);
        const rematch = body.match(/CLAIM (\d+(\.\d+)?) (XDAI|DAI|WXDAI)/g);
        const altMatch = body.match(/\[\s*\[\s*(\d+(\.\d+)?)\s*(XDAI|DAI|WXDAI)\s*\]\]/g);

        // Match: https://pay.ubq.fi?claim=  & https://pay.ubq.fi/?claim=
        const permitMatch = body.match(/https:\/\/pay\.ubq\.fi\/?\?claim=[^)]*/g);

        const creator = body.includes("Task Creator Reward") ? true : false;
        const conversation = body.includes("Conversation Rewards") ? true : false;
        const type = creator ? "creator" : conversation ? "conversation" : "assignee";

        /**
         * Most of the time the awards are in the format:
         * Assignee >>: ### [ **[ CLAIM 25 WXDAI ],25,,WXDAI
         * Convo|Creator >>: ### [ **gitcoindev: [ CLAIM 18.6 WXDAI ],18.6,.6,WXDAI
         * Assignee >>: ### [ **[ CLAIM 25 WXDAI ],25,,WXDAI
         * Convo|Creator >>: ### [ **rndquu: [ CLAIM 23.4 WXDAI ],23.4,.4,WXDAI
         */

        let user = "DEBUG";

        if (comment.node.author?.login === "ubiquibot") {
          // parse only bot comments
          const containsPermit = permitMatch ? permitMatch[0] : "No permit found";

          if (containsPermit !== "No permit found") {
            // this is catching cases as seen in https://github.com/ubiquity/nft-rewards/issues/2
            // https://pay.ubq.fi?claim= & https://pay.ubq.fi?claim=
            const permitCount = Array.from(new Set<string>(body.match(/https:\/\/pay\.ubq\.fi\/?\?claim=[^\s]*/g)));

            if (permitCount.length > 1) {
              /**
               * this is the newer <details> type awards edge case
               *
               * ### [ [ 1.7 WXDAI ]]
               * ###### @pavlovcik
               * ### [ [ 47.6 WXDAI ]]
               * ###### @rndquu
               */

              for (const permit of permitCount) {
                // if theres a newline then extraction may have failed
                const match = permit.match(/\n/g);

                if (match) {
                  debugData.push({
                    repoName,
                    issueNumber,
                    paymentAmount: 0,
                    currency: "xxx",
                    payee: "xxx",
                    type,
                    url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
                    comment: body,
                    permit: JSON.stringify(permitCount),
                    issueCreator,
                    typeOfMatch: "permit-has-newline",
                  });
                } else {
                  permits.push({
                    repoName,
                    issueNumber,
                    url: permit,
                  });
                }
              }

              const users = Array.from(new Set<string>(body.match(/@\w+/g)));
              const payouts = body.match(/\*?(\d+(\.\d+)?) \*?(XDAI|DAI|WXDAI)\*?/g);

              if (payouts.length > users.length) {
                const usernameReg = /\[ \*\*([^:]+):/g;

                const usernames = body.match(usernameReg).map((user: string) => user.split("**")[1].split(":")[0]);

                console.log("more payments than users", payouts, usernames);
                for (const user of usernames) {
                  let type = user === issueAssignee ? "assignee" : user === issueCreator ? "creator" : "conversation";

                  console.log(`
                  ${user} should be paid ${payouts[usernames.indexOf(user)]} in ${repoName} #${issueNumber}
                  `);

                  const payment = {
                    repoName,
                    issueNumber,
                    paymentAmount: parseFloat(payouts[usernames.indexOf(user)]?.split(" ")[0] ?? "0") ?? 0,
                    currency: payouts[usernames.indexOf(user)]?.split(" ")[1] ?? "yyy",
                    payee: user,
                    type: type,
                    url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
                  };
                  payments.add(payment);

                  if (user === "No assignee") {
                    noAssigneePayments.add(payment);
                  }

                  if (payment.currency === "yyy") {
                    debugData.push({
                      repoName,
                      issueNumber,
                      paymentAmount: 0,
                      currency: "xxx",
                      payee: "xxx",
                      type,
                      url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
                      comment: body,
                      permit: JSON.stringify(permitCount),
                      issueCreator,
                      typeOfMatch: "more-payments-than-users",
                    });
                  }
                }
                console.log(`https://github.com/${org}/${repoName}/issues/${issueNumber}`);
                console.log(`============================`);
              }

              for (const user of users) {
                let usr = user.split("@")[1];

                console.log(`USER found in ${repoName} #${issueNumber}: \n`, usr);

                const payment = {
                  repoName,
                  issueNumber,
                  paymentAmount: parseFloat(payouts[users.indexOf(user)]?.split(" ")[0] ?? "0") ?? 0,
                  currency: payouts[users.indexOf(user)]?.split(" ")[1] ?? "yyy",
                  payee: usr,
                  type: usr === issueAssignee ? "assignee" : usr === issueCreator ? "creator" : "conversation",
                  url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
                };

                payments.add(payment);

                if (usr === "No assignee") {
                  noAssigneePayments.add(payment);
                }
              }

              continue;
            }

            // check the match for a '\n' and if there is one then add to debug
          } else {
            if (match || altMatch || rematch) {
              console.log("match", match);
              console.log("altMatch", altMatch);
              console.log("rematch", rematch);

              debugData.push({
                repoName,
                issueNumber,
                paymentAmount: 0,
                currency: "xxx",
                payee: "xxx",
                type,
                url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
                comment: body,
                permit: permitMatch,
                issueCreator,
                typeOfMatch: "no-permit-but-match-found",
              });
            }
          }

          if (match) {
            // Match: "... [ **CLAIM 17(.5) WXDAI** ] ..."

            // comments around the start of 2023 do not have creator/conversation prefixes
            // but those types of comments were not introduced until the end of 2023
            // so we're best guessing they are assignee rewards

            if (creator || conversation) {
              // we know for a fact it's the creator or conversation reward

              // this should be either the creator's or conversation awards as they are named
              // the only time this rule breaks is the <details> type awards and the assignee is named too
              // although the claim format is different 'gitcoindev: [ CLAIM 18.6 WXDAI ]' vs '[ [ 18.6 WXDAI ] ]'

              console.log(`creator/convo award found in ${repoName} #${issueNumber}: \n`, match);

              const payment = {
                repoName,
                issueNumber,
                paymentAmount: !isNaN(parseFloat(match[1])) ? parseFloat(match[1]) : 0,
                currency: match[3],
                payee: user,
                type,
                url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
              };

              payments.add(payment);

              if (user === "No assignee") {
                noAssigneePayments.add(payment);
              }
            } else {
              // if we are here then it is the assignee's award

              console.log(`assignee award found in ${repoName} #${issueNumber}: \n`, match);

              const payment = {
                repoName,
                issueNumber,
                paymentAmount: !isNaN(parseFloat(match[1])) ? parseFloat(match[1]) : 0,
                currency: match[3],
                payee: issueAssignee,
                type,
                url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
              };

              payments.add(payment);

              if (issueAssignee === "No assignee") {
                noAssigneePayments.add(payment);
              }
            }
          } else if (altMatch) {
            // Match: ... [ [ 123.45 WXDAI ] ] ..."

            console.log(`altMatch award found in ${repoName} #${issueNumber}: \n`, altMatch);

            // this is the newer <details> type awards
            const users = altMatch.input.match(/###### @\w+/g).map((user: string) => user.split(" ")[1]);

            // multiple payouts so pulling them both out
            const payouts = altMatch.input.match(/\*?(\d+(\.\d+)?) \*?(XDAI|DAI|WXDAI)\*?/g);

            /**
            ### [ [ 1.7 WXDAI ]]
            ###### @pavlovcik
            ### [ [ 47.6 WXDAI ]]
            ###### @rndquu
            */

            for (const user of users) {
              let usr = user.split("@")[1];

              const payment = {
                repoName,
                issueNumber,
                paymentAmount: !isNaN(parseFloat(payouts[users.indexOf(user)].split(" ")[0])) ? parseFloat(payouts[users.indexOf(user)].split(" ")[0]) : 0,
                currency: payouts[users.indexOf(user)].split(" ")[1],
                payee: usr,
                type,
                url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
              };

              payments.add(payment);

              if (usr === "No assignee") {
                noAssigneePayments.add(payment);
              }
            }
          } else if (rematch) {
            // ... CLAIM 123.45 WXDAI ...

            const payment = {
              repoName,
              issueNumber,
              paymentAmount: parseFloat(rematch[0].split(" ")[1]),
              currency: rematch[0].split(" ")[2],
              payee: issueAssignee,
              type,
              url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
            };

            payments.add(payment);

            if (issueAssignee === "No assignee") {
              noAssigneePayments.add(payment);
            }
          } else if (containsPermit !== "No permit found") {
            // https://pay.ubq.fi?claim=https://pay.ubq.fi?claim=
            const reg = /https:\/\/pay\.ubq\.fi\?claim=([^)]*)/g;
            const permit = body.match(reg);
            if (permit) {
              debugData.push({
                repoName,
                issueNumber,
                paymentAmount: 0,
                currency: "xxx",
                payee: "xxx",
                type,
                url: `https://github.com/${org}/${repoName}/issues/${issueNumber}`,
                comment: body,
                permit: permitMatch,
                issueCreator,
                typeOfMatch: "no-match-but-permit-found",
              });
            }
          } else {
            // no match found
          }
        }
      }
    }

    hasNextPage = response.repository.issues.pageInfo.hasNextPage;
    cursor = response.repository.issues.pageInfo.endCursor;
  }

  const data = {
    payments: Array.from(payments),
    noAssigneePayments: Array.from(noAssigneePayments),
    debugData,
    permits,
  };

  return data;
}

// Process a single repository for payment comments in [CLOSED, OPEN] issues
export async function processRepo(org: string, repo: Repositories, since: string, oneCsv: boolean) {
  console.log(`Processing ${repo.name}...\n`);
  const allPayments: PaymentInfo[] = [];
  const allNoAssigneePayments: PaymentInfo[] = [];
  const noPayments: NoPayments[] = [];
  const contributors: Contributor = {};
  const payments = await fetchPaymentsForRepository(org, repo.name, since);

  if (payments.debugData.length > 0) {
    const sorted = payments.debugData.sort((a, b) => b.paymentAmount - a.paymentAmount);
    const deduped = removeDuplicates(sorted);
    const csvdata = await dataToCSV(deduped);

    writeToFile(`./debug/repos/${repo.name}.json`, JSON.stringify(payments.debugData, null, 2));
    writeToFile(`./debug/repos/${repo.name}.csv`, csvdata);
  }

  if (payments.payments.length === 0) {
    noPayments.push({
      repoName: repo.name,
      archived: repo.isArchived,
      lastCommitDate: repo.lastCommitDate,
      message: "No payments found",
      url: `https://github.com/${org}/${repo.name}`,
    });
  }

  if (payments.permits.length > 0) {
    const deduped = removeDuplicates(payments.permits);
    writeToFile(`./debug/repos/${repo.name}-permits.json`, JSON.stringify(deduped, null, 2));
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
      permits: payments.permits,
    });
    return;
  } else {
    return {
      repo,
      contributors,
      allPayments,
      allNoAssigneePayments,
      noPayments,
      permits: payments.permits,
    };
  }
}

// Process all repositories for payment comments in all issues
export async function processRepositories(org: string, since: string): Promise<CSVData | undefined> {
  const repos = await fetchPublicRepositories(org);

  const processedRepos: CSVData = {
    contributors: {},
    allPayments: [],
    allNoAssigneePayments: [],
    noPayments: [],
    permits: [],
  };

  for (const repo of repos) {
    if (repo.isArchived) {
      console.log(`Skipping archived repository: ${repo.name}`);
      continue;
    }
    const processed = await processRepo(org, repo, since, true);

    if (!processed) {
      console.log(`No data for ${repo.name}`);
      continue;
    }

    processedRepos.allPayments.push(...processed.allPayments);
    processedRepos.allNoAssigneePayments.push(...processed.allNoAssigneePayments);
    processedRepos.noPayments.push(...processed.noPayments);
    processedRepos.permits.push(...processed.permits);

    for (const [username, balance] of Object.entries(processed.contributors)) {
      if (processedRepos.contributors[username]) {
        processedRepos.contributors[username] += balance;
      } else {
        processedRepos.contributors[username] = balance;
      }
    }
  }

  return processedRepos;
}
