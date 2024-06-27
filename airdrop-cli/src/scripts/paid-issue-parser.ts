import { request, gql } from "graphql-request";
import { IssueOut, PermitDetails, Repositories, User } from "../types";
import dotenv from "dotenv";
import { Octokit } from "@octokit/rest";
import { getSupabaseData, loader } from "./utils";
import { writeFile } from "fs/promises";

dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";

const orgs = ["Ubiquity", "ubiquibot"];

/**
 * Refactoring of tally.ts into a far more maintainable class.
 *
 * Collects permits by parsing comments on issues in repos.
 * Specifically, it looks for comments from ubiquibot, pavlovcik, and 0x4007.
 *
 * If ran by someone with private repo access, I'm sure it will tally those up too.
 *
 * Reliance is solely on the claim url to extract the permit data.
 * Most fruitful of the three methods.
 */
export class PaidIssueParser {
  walletToIdMap = new Map<string, number>();
  idToWalletMap = new Map<number, string>();
  users: User[] | null = [];
  octokit = new Octokit({ auth: GITHUB_TOKEN });
  sigPaymentInfo: Record<string, IssueOut> = {};

  async run() {
    const loader_ = loader();
    const supabaseData = await getSupabaseData();

    this.idToWalletMap = supabaseData.idToWalletMap;
    this.users = supabaseData.users;
    this.walletToIdMap = supabaseData.walletToIdMap;

    await this.processOrgAndRepos();

    clearInterval(loader_);
    console.log(`[PaidIssueParser] Finished processing ${Object.keys(this.sigPaymentInfo).length} permits.`);
    await writeFile("src/scripts/data/issue-sigs.json", JSON.stringify(this.sigPaymentInfo, null, 2));
    return this.sigPaymentInfo;
  }

  async processOrgAndRepos() {
    // promises are too quick and they hit secondary rate limit
    for (const org of orgs) {
      const repos = await this.getPublicRepos(org);

      for await (const repo of repos) {
        if (repo.isArchived) continue;
        console.log(`Processing ${org}/${repo.name}`);

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
        console.log("Rate limit exceeded, pausing...");

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
      console.log(err);
    }
    return this.sigPaymentInfo;
  }

  async _fetchAndProcessRepoComments(org: string, repoName: string, response: GraphQlGitHubResponse) {
    for (const issue of response.repository.issues.edges) {
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

        hasNextPageComments = commentsResponse.repository.issue.comments.pageInfo.hasNextPage;
        commentsCursor = commentsResponse.repository.issue.comments.pageInfo.endCursor;
      }

      if (!comments.length) continue;

      for (const comment of comments) {
        const timestamp = comment.node.createdAt;
        const body = comment.node.body;
        await this.parseComment(body, repoName, issueNumber, issueCreator, issueAssignee, timestamp);
      }
    }
  }

  async parseComment(body: string, repoName: string, issueNumber: number, issueCreator: string, issueAssignee: string, timestamp: string) {
    const matched = this.commentContainsPermit(body);
    const paymentInfo = await this.parsePaymentInfo(matched);
    if (!paymentInfo) return;

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
        reward: permit,
      };

      this.sigPaymentInfo[permit.signature.toLowerCase()] = toPush;
    }
  }

  async parsePaymentInfo(matched: string[] | null) {
    if (!matched) {
      return null;
    } else if (matched.length === 1) {
      return [await this.parsePermitData(matched[0])];
    }
    const permits = [];
    for (const permitStr of matched) {
      permits.push(await this.parsePermitData(permitStr));
    }

    return permits;
  }

  async parsePermitData(claimUrl: string) {
    let permitString = this.sanitizeClaimUrl(claimUrl);
    if (!permitString) return;
    claimUrl = `https://pay.ubq.fi/?claim=${permitString}`;
    try {
      permitString = atob(permitString);
    } catch {
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
        console.log("Error fetching user", "error", error);
      }
    }


    return {
      claimUrl,
      claimantUsername,
      permit: JSON.parse(permitString) as PermitDetails,
    };
  }

  commentContainsPermit(comment: string) {
    return comment.match(/https:\/\/pay\.ubq\.fi\/?\?claim=[^\s]*/g);
  }

  sanitizeClaimUrl(str: string) {
    // capture only the base64 string after `claim='
    const base64Regex = /=[A-Za-z0-9+/=]+/g;
    const base64str = str.match(base64Regex);
    if (!base64str) return null;
    return base64str[0].slice(1);
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
      console.log(`Failed to fetch user data for ${userId}`);
      return;
    }

    return {
      id: data.id,
      username: data.login,
      name: data.name,
    };
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
