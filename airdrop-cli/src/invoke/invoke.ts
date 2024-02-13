import * as dotenv from "dotenv";
import { request, gql } from "graphql-request";
import { dataToCSV, loadingBar, removeDuplicates, writeCSV, writeToFile } from "../utils";
import { Repositories, PaymentInfo, NoPayments, Contributor, CSVData, DebugData, Permits } from "../types";
import { crossReferencePermitsWithPayments, decodePermits } from "../utils/debug";

dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";

const NO_ASSIGNEE = "No assignee";
const NO_PERMIT_FOUND = "No permit found";
const org = "Ubiquity";

interface ProcessData {
  isCreator: boolean;
  isConversation: boolean;
  user: string;
  repoName: string;
  issueNumber: number;
  issueAssignee: string;
  issueCreator: string;
  type: string;
}

function commentUrl(repoName: string, issueNumber: string) {
  return `https://github.com/${org}/${repoName}/issues/${issueNumber}`;
}

export async function invoke(timeFrom?: string) {
  const since = "2023-01-01T00:00:00.000Z";
  const loader = await loadingBar();

  const data: CSVData | undefined = await processRepositories(org, timeFrom ? timeFrom : since);

  if (!data) {
    throw new Error("No data found processing all repositories.");
  }

  /**
   * it's very unlikely that a user has two payments for the exact same amount
   * on the same issue: creator earns less than assignee, and convo rewards shouldn't
   * be more than assignee rewards. It's possible I guess but very unlikely.
   */

  const deduped = data.allPayments.filter(
    (v, i, a) =>
      a.findIndex(
        (t) =>
          t.repoName === v.repoName &&
          t.issueNumber === v.issueNumber &&
          t.paymentAmount === v.paymentAmount &&
          t.currency === v.currency &&
          t.payee === v.payee
      ) === i
  );
  data.allPayments = deduped;

  await decodePermits(data.permits);
  await crossReferencePermitsWithPayments(data.permits, data.allPayments);

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  let payments = new Set<PaymentInfo>();
  let noAssigneePayments = new Set<PaymentInfo>();
  let debugData: DebugData[] = [];
  let permits: Permits[] = [];

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await request(GITHUB_GRAPHQL_API, query, { org, repoName, cursor, since }, { Authorization: `Bearer ${GITHUB_TOKEN}` });

    for (const issue of response.repository.issues.edges) {
      const issueNumber = issue.node.number;
      const issueCreator = issue.node.author?.login;

      // Issues without an assignee are typically issues reopened or edge cases
      const issueAssignee = issue.node.assignees.edges.length > 0 ? issue.node.assignees.edges[0].node?.login : NO_ASSIGNEE;

      for (const comment of issue.node.comments.edges) {
        const body = comment.node.body;

        if (comment.node.author?.login === "ubiquibot") {
          const {
            permits: p,
            payments: pay,
            noAssigneePayments: noP,
            debugData: dd,
          } = await processComment(body, repoName, issueNumber, issueAssignee, issueCreator, permits, payments, noAssigneePayments, debugData);

          permits = Array.from(new Set([...permits, ...p]));
          payments = new Set(pay);
          noAssigneePayments = new Set(noP);
          debugData = Array.from(new Set([...debugData, ...dd]));
        }
      }
    }

    hasNextPage = response.repository.issues.pageInfo.hasNextPage;
    cursor = response.repository.issues.pageInfo.endCursor;
  }

  return {
    payments: Array.from(payments),
    noAssigneePayments: Array.from(noAssigneePayments),
    debugData,
    permits,
  };
}

async function processComment(
  comment: string,
  repoName: string,
  issueNumber: number,
  issueAssignee: string,
  issueCreator: string,
  permits: Permits[] = [],
  payments: Set<PaymentInfo> = new Set(),
  noAssigneePayments: Set<PaymentInfo> = new Set(),
  debugData: DebugData[] = []
) {
  if (!comment) return { permits, payments, noAssigneePayments, debugData };

  const match = comment.match(/\*\*CLAIM (\d+(\.\d+)?) (XDAI|DAI|WXDAI)\*\*/g);
  const rematch = comment.match(/CLAIM (\d+(\.\d+)?) (XDAI|DAI|WXDAI)/g);
  const altMatch = comment.match(/\[\s*\[\s*(\d+(\.\d+)?)\s*(XDAI|DAI|WXDAI)\s*\]\]/g);
  const permitMatch = comment.match(/https:\/\/pay\.ubq\.fi\/?\?claim=[^)]*/g);

  const isCreator = comment.includes("Task Creator Reward") ? true : false;
  const isConversation = comment.includes("Conversation Rewards") ? true : false;
  const type = isCreator ? "creator" : isConversation ? "conversation" : "assignee";
  const user: string = "DEBUG";
  const containsPermit = permitMatch ? permitMatch[0] : NO_PERMIT_FOUND;

  if (containsPermit !== NO_PERMIT_FOUND) {
    const {
      permits: perms,
      payments: p,
      noAssigneePayments: noP,
      debugData: dd,
    } = await processPermits(comment, repoName, issueNumber, issueAssignee, issueCreator, permits, payments, noAssigneePayments, debugData);

    permits = perms;
    payments = p;
    noAssigneePayments = noP;
    debugData = dd;
  }

  if (match) {
    const { payments: p, noAssigneePayments: noP } = await processMatch(
      {
        isCreator,
        isConversation,
        user,
        repoName,
        issueNumber,
        issueAssignee,
        issueCreator,
        type,
      },
      match,
      payments,
      noAssigneePayments
    );

    payments = p;
    noAssigneePayments = noP;
  } else if (altMatch) {
    const { payments: p, noAssigneePayments: noP } = await processAltMatch(
      {
        isCreator,
        isConversation,
        user,
        repoName,
        issueNumber,
        issueAssignee,
        issueCreator,
        type,
      },
      altMatch,
      payments,
      noAssigneePayments
    );

    payments = p;
    noAssigneePayments = noP;
  } else if (rematch) {
    const { payments: p, noAssigneePayments: noP } = await processRematch(
      {
        isCreator,
        isConversation,
        user,
        repoName,
        issueNumber,
        issueAssignee,
        issueCreator,
        type,
      },
      rematch,
      payments,
      noAssigneePayments
    );

    payments = p;
    noAssigneePayments = noP;
  } else if (containsPermit !== NO_PERMIT_FOUND) {
    await pushDebugData(comment, repoName, issueNumber, issueAssignee, issueCreator, type, debugData, "no-match-but-permit-found", containsPermit);
  }

  return { permits, payments, noAssigneePayments, debugData };
}

async function processMatch(data: ProcessData, match: RegExpMatchArray, payments: Set<PaymentInfo>, noAssigneePayments: Set<PaymentInfo>) {
  const payment = {
    repoName: data.repoName,
    issueNumber: data.issueNumber,
    paymentAmount: !isNaN(parseFloat(match[1])) ? parseFloat(match[1]) : 0,
    currency: match[3],
    payee: data.user,
    type: data.type,
    url: commentUrl(data.repoName, data.issueNumber.toString()),
  };

  payments.add(payment);

  if (data.user === NO_ASSIGNEE) {
    noAssigneePayments.add(payment);
  }

  return { payments, noAssigneePayments };
}

async function processAltMatch(data: ProcessData, altMatch: RegExpMatchArray, payments: Set<PaymentInfo>, noAssigneePayments: Set<PaymentInfo>) {
  if (!altMatch.input) return { payments, noAssigneePayments };
  const matchForUsers = altMatch.input.match(/###### @\w+/g);
  if (!matchForUsers) return { payments, noAssigneePayments };

  const users = matchForUsers.map((user: string) => user.split(" ")[1]);
  const payouts = altMatch.input.match(/\*?(\d+(\.\d+)?) \*?(XDAI|DAI|WXDAI)\*?/g);

  if (!payouts) return { payments, noAssigneePayments };

  for (const user of users) {
    const usr = user.split("@")[1];

    const payment = {
      repoName: data.repoName,
      issueNumber: data.issueNumber,
      paymentAmount: !isNaN(parseFloat(payouts[users.indexOf(user)].split(" ")[0])) ? parseFloat(payouts[users.indexOf(user)].split(" ")[0]) : 0,
      currency: payouts[users.indexOf(user)].split(" ")[1],
      payee: usr,
      type: data.type,
      url: commentUrl(data.repoName, data.issueNumber.toString()),
    };

    payments.add(payment);

    if (usr === NO_ASSIGNEE) {
      noAssigneePayments.add(payment);
    }
  }

  return { payments, noAssigneePayments };
}

async function processRematch(data: ProcessData, rematch: RegExpMatchArray, payments: Set<PaymentInfo>, noAssigneePayments: Set<PaymentInfo>) {
  const payment = {
    repoName: data.repoName,
    issueNumber: data.issueNumber,
    paymentAmount: parseFloat(rematch[0].split(" ")[1]),
    currency: rematch[0].split(" ")[2],
    payee: data.issueAssignee,
    type: data.type,
    url: commentUrl(data.repoName, data.issueNumber.toString()),
  };

  payments.add(payment);

  if (data.issueAssignee === NO_ASSIGNEE) {
    noAssigneePayments.add(payment);
  }

  return {
    payments,
    noAssigneePayments,
  };
}

async function processPermits(
  comment: string,
  repoName: string,
  issueNumber: number,
  issueAssignee: string,
  issueCreator: string,
  permits: Permits[] = [],
  payments: Set<PaymentInfo> = new Set(),
  noAssigneePayments: Set<PaymentInfo> = new Set(),
  debugData: DebugData[] = []
) {
  const permitCount = Array.from(new Set<string>(comment.match(/https:\/\/pay\.ubq\.fi\/?\?claim=[^\s]*/g)));

  const users = Array.from(new Set<string>(comment.match(/@\w+/g)));
  const payouts = comment.match(/\*?(\d+(\.\d+)?) \*?(XDAI|DAI|WXDAI)\*?/g);

  if (permitCount.length > 1) {
    for (const permit of permitCount) {
      permits.push({
        repoName,
        issueNumber,
        url: permit,
      });
    }

    if (payments.size > users.length) {
      const {
        payments: p,
        noAssigneePayments: noP,
        debugData: dd,
      } = await processMultiPermitComments(comment, repoName, issueNumber, issueAssignee, issueCreator, payouts ?? [], payments, noAssigneePayments, debugData);

      payments = p;
      noAssigneePayments = noP;
      debugData = dd;
    }

    for (const user of users) {
      const {
        payments: p,
        noAssigneePayments: noP,
        debugData: dd,
      } = await processSinglePermitComments(
        comment,
        user,
        repoName,
        issueNumber,
        issueAssignee,
        issueCreator,
        users,
        payouts ?? [],
        payments,
        noAssigneePayments,
        debugData
      );

      payments = p;
      noAssigneePayments = noP;
      debugData = dd;
    }
  } else {
    const permit = permitCount[0];

    permits.push({
      repoName,
      issueNumber,
      url: permit,
    });
  }

  return { permits, payments, noAssigneePayments, debugData };
}

async function processSinglePermitComments(
  comment: string,
  user: string,
  repoName: string,
  issueNumber: number,
  issueAssignee: string,
  issueCreator: string,
  users: string[],
  payouts: string[],
  payments: Set<PaymentInfo>,
  noAssigneePayments: Set<PaymentInfo>,
  debugData: DebugData[] = []
) {
  const usr = user.split("@")[1];

  const payment = {
    repoName,
    issueNumber,
    paymentAmount: parseFloat(payouts[users.indexOf(user)]?.split(" ")[0] ?? "0") ?? 0,
    currency: payouts[users.indexOf(user)]?.split(" ")[1] ?? "DEBUG",
    payee: usr,
    type: usr === issueAssignee ? "assignee" : usr === issueCreator ? "creator" : "conversation",

    url: commentUrl(repoName, issueNumber.toString()),
  };

  payments.add(payment);

  if (user === NO_ASSIGNEE) {
    noAssigneePayments.add(payment);
  } else if (user === "DEBUG") {
    await pushDebugData(
      comment,
      repoName,
      issueNumber,
      issueAssignee,
      issueCreator,
      payment.type ?? "conversation",
      debugData,
      "single-permit-user-debug",
      "DEBUG"
    );
  } else if (payment.paymentAmount === 0) {
    await pushDebugData(
      comment,
      repoName,
      issueNumber,
      issueAssignee,
      issueCreator,
      payment.type ?? "conversation",
      debugData,
      "single-permit-zero-payment",
      "DEBUG"
    );
  }

  return { payments, noAssigneePayments, debugData };
}

// 16/15 complexity
// eslint-disable-next-line sonarjs/cognitive-complexity
async function processMultiPermitComments(
  comment: string,
  repoName: string,
  issueNumber: number,
  issueAssignee: string,
  issueCreator: string,
  payouts: string[],
  payments: Set<PaymentInfo> = new Set(),
  noAssigneePayments: Set<PaymentInfo> = new Set(),
  debugData: DebugData[] = []
) {
  const usernameReg = /\[ \*\*([^:]+):/g;
  const matched = comment.match(usernameReg);
  if (!matched) return { payments, noAssigneePayments, debugData };

  const usernames = matched.map((user: string) => user.split("**")[1].split(":")[0]);

  for (const user of usernames) {
    const type = user === issueAssignee ? "assignee" : user === issueCreator ? "creator" : "conversation";

    const payment = {
      repoName,
      issueNumber,
      paymentAmount: parseFloat(payouts[usernames.indexOf(user)]?.split(" ")[0] ?? "0") ?? 0,
      currency: payouts[usernames.indexOf(user)]?.split(" ")[1] ?? "DEBUG",
      payee: user,
      type: type,
      url: commentUrl(repoName, issueNumber.toString()),
    };

    payments.add(payment);

    if (user === NO_ASSIGNEE) {
      noAssigneePayments.add(payment);
    } else if (user === "DEBUG") {
      await pushDebugData(
        comment,
        repoName,
        issueNumber,
        issueAssignee,
        issueCreator,
        payment.type ?? "conversation",
        debugData,
        "multi-permit-user-debug",
        "DEBUG"
      );
    } else if (payment.paymentAmount === 0) {
      await pushDebugData(
        comment,
        repoName,
        issueNumber,
        issueAssignee,
        issueCreator,
        payment.type ?? "conversation",
        debugData,
        "multi-permit-zero-payment",
        "DEBUG"
      );
    }
  }

  return { payments, noAssigneePayments, debugData };
}

async function pushDebugData(
  comment: string,
  repoName: string,
  issueNumber: number,
  issueAssignee: string,
  issueCreator: string,
  type: string,
  debugData: DebugData[],
  typeOfMatch: string,
  permit: string
) {
  debugData.push({
    repoName,
    issueNumber,
    paymentAmount: 0,
    currency: "DEBUG",
    payee: `DEBUG-assignee-${issueAssignee}`,
    type,
    url: `https://github.com/ubiquity/${repoName}/issues/${issueNumber}`,
    comment: comment,
    permit,
    issueCreator,
    typeOfMatch,
  });
}

// Process a single repository for payment comments
export async function processRepo(org: string, repo: Repositories, since: string, oneCsv: boolean) {
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

  if (payments.debugData.length > 0) {
    const sorted = payments.debugData.sort((a, b) => b.paymentAmount - a.paymentAmount);
    const deduped = removeDuplicates(sorted);
    const csvdata = await dataToCSV(deduped);

    await writeToFile(`./debug/repos/${repo.name}.json`, JSON.stringify(deduped, null, 2));
    await writeToFile(`./debug/repos/${repo.name}.csv`, csvdata);
  }

  if (payments.permits.length > 0) {
    const deduped = removeDuplicates(payments.permits);

    await writeToFile(
      `./debug/repos/${repo.name}-permits.json`,
      JSON.stringify(
        deduped.sort((a, b) => a.repoName.localeCompare(b.repoName)),
        null,
        2
      )
    );
  }

  if (payments.payments.length > 0) {
    const deduped = removeDuplicates(payments.payments);
    allPayments.push(...deduped);

    await writeToFile(`./debug/repos/${repo.name}-payments.json`, JSON.stringify(deduped, null, 2));
  }

  if (payments.noAssigneePayments.length > 0) {
    const deduped = removeDuplicates(payments.noAssigneePayments);
    allNoAssigneePayments.push(...deduped);

    await writeToFile(`./debug/repos/${repo.name}-no-assignee-payments.json`, JSON.stringify(deduped, null, 2));
  }

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
    await writeCSV({
      contributors,
      allPayments,
      allNoAssigneePayments,
      noPayments,
      permits: payments.permits,
    });

    return undefined;
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
