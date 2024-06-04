import { request, gql } from "graphql-request";
import { PermitDetails, Repositories, User } from "../types";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Octokit } from "@octokit/rest";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../utils/constants";
import { getSupabaseData, loader } from "./utils";

dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";
const base64Regex = /[A-Za-z0-9+/=]+/g;

const orgs = ["Ubiquity", "ubiquibot"];

/**
 * Refactoring of tally.ts into a more maintainable class.
 *
 * Collects permits by parsing comments on issues in public repos.
 * Specifically, it looks for comments from ubiquibot, pavlovcik, and 0x4007.
 *
 * Reliance is solely on the claim url to extract the permit data.
 * Most fruitful of the three methods.
 */
export class PaidIssueParser {
  walletToIdMap = new Map<string, number>();
  idToWalletMap = new Map<number, string>();
  users: User[] | null = [];
  octokit = new Octokit({ auth: GITHUB_TOKEN });
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // repo -> issueNumber -> IssueOut[]
  repoPaymentInfo: Record<string, Record<number, IssueOut[]>> = {};
  // Signature -> IssueOut
  sigPaymentInfo: Record<string, IssueOut> = {};
  // wallet -> IssueOut[]
  walletPaymentInfo: Record<string, IssueOut[]> = {};

  async run() {
    const loader_ = loader();
    const { idToWalletMap: idWalletMap, users: _users, walletToIdMap: walletMap } = await getSupabaseData(this.sb);

    this.idToWalletMap = idWalletMap;
    this.users = _users;
    this.walletToIdMap = walletMap;

    await this.processOrgAndRepos();

    clearInterval(loader_);
    this.log(`[PaidIssueParser] Finished processing ${Object.keys(this.repoPaymentInfo).length} repos`);

    return {
      repoPaymentInfo: this.repoPaymentInfo,
      sigPaymentInfo: this.sigPaymentInfo,
      walletPaymentInfo: this.walletPaymentInfo,
    };
  }

  async processOrgAndRepos() {
    for (const org of orgs) {
      const repos = await this.getPublicRepos(org);

      for await (const repo of repos) {
        if (repo.isArchived) continue;
        this.log(`Processing ${org}/${repo.name}`);

        const shouldRetry = await this._processOrgAndRepos(org, repo);

        if (shouldRetry) {
          await this._processOrgAndRepos(org, repo);
        }
      }
    }
  }

  async _processOrgAndRepos(org: string, repo: Repositories) {
    try {
      await this.fetchAndProcessRepoComments(org, repo.name);
    } catch (e) {
      if (e instanceof Error && e.message.includes("rate limit")) {
        this.log("Rate limit exceeded, pausing...");

        const rateLimit = await this.octokit.rateLimit.get();
        const resetTime = rateLimit.data.resources.core.reset * 1000;
        const waitTime = resetTime - Date.now();

        await new Promise((resolve) => setTimeout(resolve, waitTime));
        return true;
      } else {
        // Rethrow error if it's not a rate limit error
        throw e;
      }
    }
    return false;
  }

  async getPublicRepos(org: string = "Ubiquity", repo?: string): Promise<Repositories[]> {
    let hasNextPage = true;
    let cursor = null;
    const repositories: Repositories[] = [];

    while (hasNextPage) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response: any = await request(GITHUB_GRAPHQL_API, fetchPublicRepoQuery, { org, cursor }, { Authorization: `Bearer ${GITHUB_TOKEN}` });

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

  async fetchAndProcessRepoComments(org: string, repoName: string) {
    let hasNextPage = true;
    let issueCursor = null;

    // saves scanning 1000s of issues with no permits
    if (repoName === "devpool-directory") return;

    try {
      while (hasNextPage) {
        const response: GraphQlGitHubResponse = await request(
          GITHUB_GRAPHQL_API,
          fetchCommentsQuery,
          { org, repoName, cursor: issueCursor },
          { Authorization: `Bearer ${GITHUB_TOKEN}` }
        );

        await this._fetchAndProcessRepoComments(org, repoName, response);
        hasNextPage = response.repository.issues.pageInfo.hasNextPage;
        issueCursor = response.repository.issues.pageInfo.endCursor;
      }
    } catch (err) {
      this.log(err);
    }
    return {
      repoPaymentInfo: this.repoPaymentInfo,
      sigPaymentInfo: this.sigPaymentInfo,
      walletPaymentInfo: this.walletPaymentInfo,
    };
  }

  async _fetchAndProcessRepoComments(org: string, repoName: string, response: GraphQlGitHubResponse) {
    for await (const issue of response.repository.issues.edges) {
      this.log(`${repoName}/#${issue.node.number} `);
      const issueNumber = issue.node.number;
      const issueCreator = issue.node.author?.login;
      const issueAssignee = issue.node.assignees.edges.length > 0 ? issue.node.assignees.edges[0].node?.login : "No assignee";

      let hasNextPageComments = true;
      let commentsCursor = null;
      let comments: {
        node: Comment;
      }[] = [];

      while (hasNextPageComments) {
        const commentsResponse: GraphQlGitHubResponse = await request(
          GITHUB_GRAPHQL_API,
          fetchIssueCommentsQuery,
          { org, repoName, issueNumber, cursor: commentsCursor },
          { Authorization: `Bearer ${GITHUB_TOKEN}` }
        );

        const botComments = commentsResponse.repository.issue.comments.edges.filter(
          (c) => c.node.author?.login === "ubiquibot" || c.node.author?.login === "pavlovcik" || c.node.author?.login === "0x4007"
        );

        comments = comments.concat(botComments);

        for await (const comment of botComments) {
          const timestamp = comment.node.createdAt;
          const body = comment.node.body;
          if (!this.repoPaymentInfo[repoName]) this.repoPaymentInfo[repoName] = {};

          await this.parseComment(body, repoName, issueNumber, issueCreator, comment, issueAssignee, timestamp);
        }

        hasNextPageComments = commentsResponse.repository.issue.comments.pageInfo.hasNextPage;
        commentsCursor = commentsResponse.repository.issue.comments.pageInfo.endCursor;
      }
    }
  }

  async parseComment(
    body: string,
    repoName: string,
    issueNumber: number,
    issueCreator: string,
    comment: { node: { author: { login: string }; createdAt: string } },
    issueAssignee: string,
    timestamp: string
  ) {
    // we only want comments from ubiquibot, pavlovcik, and 0x4007
    if (comment.node.author?.login === "ubiquibot" || comment.node.author?.login === "pavlovcik" || comment.node.author?.login === "0x4007") {
      // if any of the four regexes match
      const paymentInfo = await this.parsePaymentInfo(body);

      if (!paymentInfo) return;
      if (!this.repoPaymentInfo[repoName][issueNumber]) {
        this.repoPaymentInfo[repoName][issueNumber] = [];
      }

      for (const _permit of paymentInfo) {
        if (!_permit) continue;
        let { permit } = _permit;

        if (Array.isArray(permit)) {
          permit = permit[0];
        }

        const toPush = {
          beneficiary: _permit.claimantUsername,
          issueCreator,
          issueAssignee,
          issueNumber,
          repoName,
          timestamp: timestamp,
          claimUrl: _permit.claimUrl,
          permit,
        };

        this.repoPaymentInfo[repoName][issueNumber].push(toPush);
        this.sigPaymentInfo[permit.signature.toLowerCase()] = toPush;
        this.addWalletPaymentInfo(toPush);
      }
    }
  }

  addWalletPaymentInfo(permit: {
    issueCreator: string;
    issueAssignee: string;
    issueNumber: number;
    repoName: string;
    timestamp: string;
    claimUrl: string;
    permit: PermitDetails;
  }) {
    const { transferDetails } = permit.permit;

    if (!transferDetails) {
      return;
    }

    const to = transferDetails.to.toLowerCase();

    if (!this.walletPaymentInfo[to]) {
      this.walletPaymentInfo[to] = [];
    }

    this.walletPaymentInfo[to].push(permit);
  }

  async parsePaymentInfo(comment: string) {
    const urlMatch = comment.match(/https:\/\/pay\.ubq\.fi\/?\?claim=[^\s]*/g);
    const match = comment.match(base64Regex);

    if (!match) {
      return null;
    } else if (match.length === 1 && urlMatch?.length) {
      return [await this.parsePermitData(match[0], urlMatch[0])];
    }

    const claimUrls = match;
    const permits = [];

    for (const permitStr of claimUrls) {
      permits.push(await this.parsePermitData(permitStr, urlMatch?.[0] as string));
    }

    return permits;
  }

  async parsePermitData(permitStr: string, claimUrl: string) {
    let permitString = this.sanitizeClaimUrl(permitStr);
    if (!permitString) return;

    try {
      permitString = atob(permitString);
    } catch (error) {
      this.log("Failed to decode permit: \n\n\n " + permitString, "error", error);
      return;
    }

    const permit = JSON.parse(permitString);
    let _permit = permit;

    if (Array.isArray(_permit)) {
      _permit = _permit[0];
    }

    const {
      transferDetails: { to },
    } = _permit;

    const permitClaimantID = this.walletToIdMap.get(to);
    const userID = this.users?.find((u) => u.wallet_id === permitClaimantID)?.id;
    let claimantUsername = "no username found";

    if (userID) {
      try {
        claimantUsername = (await this.fetchGithubUser(userID))?.username;
      } catch (error) {
        this.log("Error fetching user", "error", error);
      }
    }

    return {
      claimUrl,
      claimantUsername,
      permit: JSON.parse(permitString) as PermitDetails,
    };
  }

  commentContainsPermit(comment: string) {
    const match = comment.match(/\*\*CLAIM (\d+(\.\d+)?) (XDAI|DAI|WXDAI)\*\*/g);
    const rematch = comment.match(/CLAIM (\d+(\.\d+)?) (XDAI|DAI|WXDAI)/g);
    const altMatch = comment.match(/\[\s*\[\s*(\d+(\.\d+)?)\s*(XDAI|DAI|WXDAI)\s*\]\]/g);
    const permitMatch = comment.match(/https:\/\/pay\.ubq\.fi\/?\?claim=[^\s]*/g);

    return !!(match || rematch || altMatch || permitMatch || base64Regex);
  }

  sanitizeClaimUrl(str: string) {
    if (!base64Regex.test(str)) return;

    str.replaceAll("%3D", "");
    str.replaceAll("%3D=", "");
    str.replaceAll('\\">', "");
    str.replaceAll('">', "");
    str.replaceAll(`)`, "");
    str.replaceAll(">", "");
    str.replaceAll("\\", "");
    str.replaceAll('"', "");
    str.replaceAll(`&network=100"`, "");

    return str;
  }

  async fetchGithubUser(userId: number) {
    if (!userId) {
      return {
        id: 0,
        username: "no username found",
        name: "no name found",
      };
    }

    const { data, status } = await this.octokit.request(`GET /user/${userId}`);

    if (status !== 200) {
      this.log(`Failed to fetch user data for ${userId}`);
      return;
    }

    return {
      id: data.id,
      username: data.login,
      name: data.name,
    };
  }

  log(message?: string | unknown, level: "info" | "error" = "info", obj?: object | null | unknown) {
    if (level === "info") {
      console.log(!obj ? message : `${message} :: \n\n + ${JSON.stringify(obj, null, 2)}`);
    }
    if (level === "error") {
      console.error(!obj ? message : `${message}   :: \n\n + ${JSON.stringify(obj, null, 2)}`);
    }
  }
}

// async function main() {
//   const parser = new PaidIssueParser();
//   await parser.run();
// }

// main()
//   .catch(console.error)
//   .finally(() => process.exit(0));

const fetchPublicRepoQuery = gql`
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

const fetchIssueCommentsQuery = gql`
  query ($org: String!, $repoName: String!, $issueNumber: Int!, $cursor: String) {
    repository(owner: $org, name: $repoName) {
      issue(number: $issueNumber) {
        comments(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              body
              author {
                login
              }
              createdAt
            }
          }
        }
      }
    }
  }
`;

const fetchCommentsQuery = gql`
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
                  createdAt
                }
              }
            }
          }
        }
      }
    }
  }
`;

type Comment = { body: string; author: { login: string }; createdAt: string };
type IssueComment = {
  node: {
    number: number;
    author: { login: string };
    assignees: { edges: { node: { login: string } }[] };
    comments: { edges: { node: Comment }[]; pageInfo: { hasNextPage: boolean; endCursor: string } };
  };
};

type GraphQlGitHubResponse = {
  repository: {
    issue: { comments: { edges: { node: Comment }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } };
    issues: { edges: IssueComment[]; pageInfo: { hasNextPage: boolean; endCursor: string } };
  };
};

export type IssueOut = {
  issueCreator: string;
  issueAssignee: string;
  issueNumber: number;
  repoName: string;
  timestamp: string;
  claimUrl: string;
  permit: PermitDetails;
};
