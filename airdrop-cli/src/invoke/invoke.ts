import * as dotenv from "dotenv";
import { request, gql } from "graphql-request";
import { dataToCSV, loadingBar, writeCSV, writeToFile } from "../utils";
import { Repositories, PaymentInfo, NoPayments, Contributor, CSVData, DebugData, Permits } from "../types";

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

export async function invoke() {
  const loader = await loadingBar();

  const data: CSVData | undefined = await processRepositories(org);

  if (!data) {
    throw new Error("No data found processing all repositories.");
  }

  await writeCSV(data);

  clearInterval(loader);
  return true;
}

// Process all repositories for payment comments in all issues
export async function processRepositories(org: string): Promise<CSVData | undefined> {
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
    const processed = await processRepo(org, repo, true);

    if (!processed) {
      console.log(`No data for ${repo.name}`);
      continue;
    }

    processedRepos.allPayments.push(...processed.allPayments);
    processedRepos.allNoAssigneePayments.push(...processed.allNoAssigneePayments);
    processedRepos.noPayments.push(...processed.noPayments);
    processedRepos.permits.push(...processed.permits);
    processedRepos.contributors = { ...processedRepos.contributors, ...processed.contributors };
  }

  return processedRepos;
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
  repoName: string
): Promise<{ payments: PaymentInfo[]; noAssigneePayments: PaymentInfo[]; debugData: DebugData[]; permits: Permits[] }> {
  let hasNextPage = true;
  let cursor = null;
  let payments: PaymentInfo[] = [];
  let noAssigneePayments: PaymentInfo[] = [];
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
    const response: any = await request(GITHUB_GRAPHQL_API, query, { org, repoName, cursor }, { Authorization: `Bearer ${GITHUB_TOKEN}` });

    for (const issue of response.repository.issues.edges) {
      const issueNumber = issue.node.number;
      const issueCreator = issue.node.author?.login;

      // Issues without an assignee are typically issues reopened or edge cases
      const issueAssignee = issue.node.assignees.edges.length > 0 ? issue.node.assignees.edges[0].node?.login : NO_ASSIGNEE;

      for (const comment of issue.node.comments.edges) {
        const body = comment.node.body;
        /**
         * I think it makes sense to parse pavlovcik's comments as well
         * this way we cover manual payments
         * I'm biased because it puts me in the top 10 but it makes sense
         * results parsing pavlovcik's comments:
         * Started with 492 permits
         * Decoded 443 permits
         * Contributors: = 53
         * All found payments: = 511
         * Repos without payments = 22
         * Top 10:
         * 0x00868BB3BA2B36316c2fc42E4aFB6D4246b77E46,5834.249999999999
         * 0xf76F1ACB66020f893c95371f740549F312DEA3f1,5036.549999999999
         * 0x3623338046b101ecEc741De9C3594CC2176f39E5,4444.65
         * 0x4841e8153a7b9E8B1F218E42d3cBaEb3e99C28eE,3859.25
         * 0x7e92476D69Ff1377a8b45176b1829C4A5566653a,3648.7999999999997
         * 0x4D0704f400D57Ba93eEa88765C3FcDBD826dCFc4,3373.65
         * 0x4007CE2083c7F3E18097aeB3A39bb8eC149a341d,2745.5500000000006
         * 0xA0B11F474d8ECE1205d38c66d5F2bE8917675d60,2276.25
         * 0x9e4EF4353C928cD3eb473E8f12aeCF58C208ef40,2196.9
         * 0xAe5D1F192013db889b1e2115A370aB133f359765,2108.15 < this is me
         *
         * results without parsing pavlovcik's comments:
         * Decoded 431 permits
         * Contributors: 51
         * All found payments: 476
         * Repos without payments: 22
         * Top 13:
         * 0x00868BB3BA2B36316c2fc42E4aFB6D4246b77E46,5834.249999999999
         * 0xf76F1ACB66020f893c95371f740549F312DEA3f1,5036.549999999999
         * 0x3623338046b101ecEc741De9C3594CC2176f39E5,4244.65
         * 0x4841e8153a7b9E8B1F218E42d3cBaEb3e99C28eE,3859.25
         * 0x4D0704f400D57Ba93eEa88765C3FcDBD826dCFc4,3373.65
         * 0x7e92476D69Ff1377a8b45176b1829C4A5566653a,3073.5
         * 0x4007CE2083c7F3E18097aeB3A39bb8eC149a341d,2371.250000000001
         * 0xA0B11F474d8ECE1205d38c66d5F2bE8917675d60,2276.25
         * 0x9e4EF4353C928cD3eb473E8f12aeCF58C208ef40,2196.9
         * 0xC3fdC486EEa63D7960e50CC5409fbeA434a6fDf3,2100
         * 0x8c8b5eeea2770e795f2814e802e335bdb9e5a3b0,1673.1
         * 0x336C033842FA316d470e820c81b742e62A0765DC,1667.3999999999999
         * 0xAe5D1F192013db889b1e2115A370aB133f359765,1621.45 this is me
         */
        if (comment.node.author?.login === "ubiquibot" || comment.node.author?.login === "pavlovcik") {
          const {
            permits: p,
            payments: pay,
            noAssigneePayments: noP,
            debugData: dd,
          } = await processComment(body, repoName, issueNumber, issueAssignee, issueCreator, permits, payments, noAssigneePayments, debugData);

          permits = Array.from(new Set([...permits, ...p]));
          payments = Array.from(new Set([...payments, ...pay]));
          noAssigneePayments = Array.from(new Set([...noAssigneePayments, ...noP]));
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
  payments: PaymentInfo[] = [],
  noAssigneePayments: PaymentInfo[] = [],
  debugData: DebugData[] = []
) {
  if (!comment) return { permits, payments, noAssigneePayments, debugData };

  const match = comment.match(/\*\*CLAIM (\d+(\.\d+)?) (XDAI|DAI|WXDAI)\*\*/g);
  const rematch = comment.match(/CLAIM (\d+(\.\d+)?) (XDAI|DAI|WXDAI)/g);
  const altMatch = comment.match(/\[\s*\[\s*(\d+(\.\d+)?)\s*(XDAI|DAI|WXDAI)\s*\]\]/g);
  const permitMatch = comment.match(/https:\/\/pay\.ubq\.fi\/?\?claim=[^\s]*/g);

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

async function processMatch(data: ProcessData, match: RegExpMatchArray, payments: PaymentInfo[], noAssigneePayments: PaymentInfo[]) {
  const payment = {
    repoName: data.repoName,
    issueNumber: data.issueNumber,
    paymentAmount: !isNaN(parseFloat(match[1])) ? parseFloat(match[1]) : 0,
    currency: match[3],
    payee: data.user,
    type: data.type,
    url: commentUrl(data.repoName, data.issueNumber.toString()),
  };

  payments.push(payment);

  if (data.user === NO_ASSIGNEE) {
    noAssigneePayments.push(payment);
  }

  return { payments, noAssigneePayments };
}

async function processAltMatch(data: ProcessData, altMatch: RegExpMatchArray, payments: PaymentInfo[], noAssigneePayments: PaymentInfo[]) {
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

    payments.push(payment);

    if (usr === NO_ASSIGNEE) {
      noAssigneePayments.push(payment);
    }
  }

  return { payments, noAssigneePayments };
}

async function processRematch(data: ProcessData, rematch: RegExpMatchArray, payments: PaymentInfo[], noAssigneePayments: PaymentInfo[]) {
  const payment = {
    repoName: data.repoName,
    issueNumber: data.issueNumber,
    paymentAmount: parseFloat(rematch[0].split(" ")[1]),
    currency: rematch[0].split(" ")[2],
    payee: data.issueAssignee,
    type: data.type,
    url: commentUrl(data.repoName, data.issueNumber.toString()),
  };

  payments.push(payment);

  if (data.issueAssignee === NO_ASSIGNEE) {
    noAssigneePayments.push(payment);
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
  payments: PaymentInfo[] = [],
  noAssigneePayments: PaymentInfo[] = [],
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

    if (payments.length > users.length) {
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
  payments: PaymentInfo[] = [],
  noAssigneePayments: PaymentInfo[] = [],
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

  payments.push(payment);

  if (user === NO_ASSIGNEE) {
    noAssigneePayments.push(payment);
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
  payments: PaymentInfo[] = [],
  noAssigneePayments: PaymentInfo[] = [],
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

    payments.push(payment);

    if (user === NO_ASSIGNEE) {
      noAssigneePayments.push(payment);
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
export async function processRepo(org: string, repo: Repositories, oneCsv: boolean) {
  console.log(`Processing ${repo.name}...\n`);
  const allPayments: PaymentInfo[] = [];
  const allNoAssigneePayments: PaymentInfo[] = [];
  const noPayments: NoPayments[] = [];
  const contributors: Contributor = {};
  let payments;

  try {
    payments = await fetchPaymentsForRepository(org, repo.name);
  } catch (err) {
    console.log(`Error fetching payments for ${repo.name}`, err);
  }

  if (!payments) {
    return;
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

  if (payments.debugData.length > 0) {
    const sorted = payments.debugData.sort((a, b) => b.paymentAmount - a.paymentAmount);
    const deduped = Array.from(new Set(sorted));
    const csvdata = await dataToCSV(deduped);

    await writeToFile(`./debug/repos/${repo.name}.json`, JSON.stringify(deduped, null, 2));
    await writeToFile(`./debug/repos/${repo.name}.csv`, csvdata);
  }

  if (payments.payments.length > 0) {
    const deduped = Array.from(new Set(payments.payments));
    allPayments.push(...deduped);

    await writeToFile(`./debug/repos/${repo.name}-payments.json`, JSON.stringify(deduped, null, 2));
  }

  if (payments.noAssigneePayments.length > 0) {
    const deduped = Array.from(new Set(payments.noAssigneePayments));
    allNoAssigneePayments.push(...deduped);

    await writeToFile(`./debug/repos/${repo.name}-no-assignee-payments.json`, JSON.stringify(deduped, null, 2));
  }

  if (!oneCsv) {
    return await writeCSV({
      contributors,
      allPayments,
      allNoAssigneePayments,
      noPayments,
      permits: payments.permits,
    });
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
