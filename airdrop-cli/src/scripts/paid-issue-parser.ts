import { request, gql } from "graphql-request";
import { PermitDetails, Repositories, User } from "../types";
import { writeFile } from "fs/promises";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Octokit } from "@octokit/rest";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../utils/constants";

type Comment = { body: string; author: { login: string }; createdAt: string };
type IssueComment = {
  node: {
    number: number;
    author: { login: string };
    assignees: { edges: { node: { login: string } }[] };
    comments: { edges: { node: Comment }[] };
  };
};

type GraphQlGitHubResponse = { repository: { issues: { edges: IssueComment[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } };

dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";

const NO_ASSIGNEE = "No assignee";
const orgs = ["Ubiquity", "ubiquibot"];
export type IssueOut = {
  issueCreator: string;
  issueAssignee: string;
  issueNumber: number;
  commentTimestamp: string;
  claimUrl: string;
  permit: PermitDetails;
};

/**
 * Refactoring of tally.ts into a more maintainable class.
 *
 * Collects permits by parsing comments on issues in public repos.
 * Specifically, it looks for comments from ubiquibot, pavlovcik, and 0x4007.
 *
 * Reliance is solely on the claim url to extract the permit data.
 *
 * The permits are then parsed and stored in two files:
 * - paid-out-repo-issue-permits.json: A list of permits by repo and issue number.
 * - paid-out-user-permits.json: A list of permits by user.
 *
 *
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
  // username -> IssueOut[]
  userPaymentInfo: Record<string, Set<IssueOut>> = {};

  // wallet -> IssueOut[]
  walletPaymentInfo: Record<string, Set<IssueOut>> = {};

  constructor() {}

  async run() {
    const loader = this.loader();
    await this.getSupabaseData();
    await this.processOrgAndRepos();

    const outFile = Object.entries(this.userPaymentInfo).map(([key, value]) => ({ [key]: Array.from(value) }));

    await writeFile("src/scripts/data/paid-out-repo-issue-permits.json", JSON.stringify(this.repoPaymentInfo, null, 2));
    await writeFile("src/scripts/data/src/scripts/data/paid-out-user-permits.json", JSON.stringify(outFile, null, 2));

    await this.leaderboard();
    clearInterval(loader);

    this.log(`[PaidIssueParser] Finished processing ${Object.keys(this.repoPaymentInfo).length} repos`);

    return {
      repoPaymentInfo: this.repoPaymentInfo,
      userPaymentInfo: this.userPaymentInfo,
    };
  }

  async processOrgAndRepos() {
    for (const org of orgs) {
      const repos = await this.getPublicRepos(org);

      for (const repo of repos) {
        if (repo.isArchived) continue;
        this.log(`Processing ${org}/${repo.name}`);
        await this.fetchAndProcessRepoComments(org, repo.name);
      }
    }
  }

  async leaderboard() {
    const loader = this.loader();

    const leaderboard: Record<string, number> = {};

    for (const user of Object.keys(this.userPaymentInfo)) {
      const payments = this.userPaymentInfo[user as keyof typeof this.userPaymentInfo];

      for (const payment of payments) {
        const { permit } = payment;
        let _permit = permit;

        if (Array.isArray(_permit)) {
          _permit = _permit[0];
        }
        const { transferDetails } = _permit;

        const to = transferDetails?.to;

        const amount = Number(transferDetails?.requestedAmount) / 1e18;

        if (!leaderboard[to]) {
          leaderboard[to] = amount;
        } else {
          leaderboard[to] += amount;
        }
      }
    }

    clearInterval(loader);

    const sorted: Record<string, number> = {};

    Object.keys(leaderboard)
      .sort((a, b) => leaderboard[b] - leaderboard[a])
      .forEach((key) => {
        sorted[key] = leaderboard[key];
      });

    const output = JSON.stringify(sorted, null, 2);

    this.log("Finished calculating leaderboard");
    await writeFile("src/scripts/data/paid-out-leaderboard.json", output);
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
    let cursor = null;

    // paginate through repo issues
    while (hasNextPage) {
      // fetch issues and comments
      const response: GraphQlGitHubResponse = await request(
        GITHUB_GRAPHQL_API,
        fetchCommentsQuery,
        { org, repoName, cursor },
        { Authorization: `Bearer ${GITHUB_TOKEN}` }
      );

      for (const issue of response.repository.issues.edges) {
        // grab some issue info
        const issueNumber = issue.node.number;
        const issueCreator = issue.node.author?.login;
        const issueAssignee = issue.node.assignees.edges.length > 0 ? issue.node.assignees.edges[0].node?.login : NO_ASSIGNEE;

        for (const comment of issue.node.comments.edges) {
          const timestamp = comment.node.createdAt;
          const body = comment.node.body;
          if (!this.repoPaymentInfo[repoName]) this.repoPaymentInfo[repoName] = {};

          await this.parseComment(body, repoName, issueNumber, issueCreator, comment, issueAssignee, timestamp);
        }
      }

      // if there are more pages, paginate
      hasNextPage = response.repository.issues.pageInfo.hasNextPage;
      cursor = response.repository.issues.pageInfo.endCursor;
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
    if (
      this.commentContainsPermit(body) &&
      (comment.node.author?.login === "ubiquibot" || comment.node.author?.login === "pavlovcik" || comment.node.author?.login === "0x4007")
    ) {
      // if any of the four regexes match
      const paymentInfo = await this.parsePaymentInfo(body);

      if (!paymentInfo) {
        return;
      }

      if (!this.repoPaymentInfo[repoName][issueNumber]) this.repoPaymentInfo[repoName][issueNumber] = [];

      for (const _permit of paymentInfo) {
        if (!_permit) {
          continue;
        }

        const { claimUrl, claimantUsername, permit } = _permit;
        const toPush = {
          issueCreator,
          issueAssignee,
          issueNumber,
          commentTimestamp: timestamp,
          claimUrl,
          permit,
        };

        // push repo payment info
        this.repoPaymentInfo[repoName][issueNumber].push(toPush);

        if (!this.userPaymentInfo[claimantUsername]) this.userPaymentInfo[claimantUsername] = new Set();

        this.userPaymentInfo[claimantUsername].add(toPush);

        this.addWalletPaymentInfo(toPush);
      }
    }
  }

  addWalletPaymentInfo(permit: {
    issueCreator: string;
    issueAssignee: string;
    issueNumber: number;
    commentTimestamp: string;
    claimUrl: string;
    permit: PermitDetails;
  }) {
    const { transferDetails } = permit.permit;

    if (!transferDetails) {
      return;
    }

    const to = transferDetails.to;

    if (!this.walletPaymentInfo[to]) {
      this.walletPaymentInfo[to] = new Set();
    }

    this.walletPaymentInfo[to].add(permit);
  }

  /**
   * Two methods of extraction:
   * - query_param of the claim_url (preferred as it covers legacy cases as well)
   * - raw metadata embedded in payout comment
   */
  async parsePaymentInfo(comment: string) {
    // target only claim urls
    const match = comment.match(/https:\/\/pay\.ubq\.fi\/?\?claim=[^\s]*/g);

    if (!match) {
      this.log("No claim url found in comment: " + comment);
      return null;
    } else if (match.length === 1) {
      const claimUrl = match[0];

      const claimParams = new URL(claimUrl);
      const permitData = claimParams.searchParams.get("claim");

      if (!permitData) {
        this.log("No permit data found in claim url: " + claimUrl);
        return null;
      }
      // return an array of one parsed permit
      return [await this.parsePermitData(permitData, claimUrl)];
    } else {
      const claimUrls = match;
      const permits = [];

      // parse each claim url
      for (const claimUrl of claimUrls) {
        const claimParams = new URL(claimUrl);
        const permitData = claimParams.searchParams.get("claim");

        if (!permitData) {
          this.log("No permit data found in claim url: " + claimUrl);
          continue;
        }

        permits.push(await this.parsePermitData(permitData, claimUrl));
      }

      return permits;
    }
  }

  async parsePermitData(permitStr: string, claimUrl: string) {
    // clean up the claim url
    let permitString = this.sanitizeClaimUrl(permitStr);

    // if it failed the sanity check, skip
    if (!permitString) {
      return;
    }

    // decode the permit
    try {
      permitString = atob(permitString);
    } catch (error) {
      this.log("Failed to decode permit: \n\n\n " + permitString, "error", error);
      return;
    }

    // parse the permit
    const permit = JSON.parse(permitString);

    let _permit = permit;

    // some permits are wrapped in an array
    if (Array.isArray(_permit)) {
      _permit = _permit[0];
    }

    const {
      transferDetails: { to },
    } = _permit;

    // get the claimant's wallet id
    const permitClaimantID = this.walletToIdMap.get(to);
    // get the claimant's github user id
    const userID = this.users?.find((u) => u.wallet_id === permitClaimantID)?.id;
    let claimantUsername = "no username found";

    if (userID) {
      try {
        // fetch the claimant's github username
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

  async getSupabaseData() {
    const { data, error } = await this.sb.from("wallets").select("address, id");

    if (error || !data?.length) {
      this.log(error?.message, "error", error);
      return { walletToIdMap: this.walletToIdMap, idToWalletMap: this.idToWalletMap, users: this.users };
    }

    for (const wallet of data) {
      this.walletToIdMap.set(wallet.address, wallet.id);
      this.idToWalletMap.set(wallet.id, wallet.address);
    }

    const { data: users, error: rr } = await this.sb.from("users").select("*").in("wallet_id", Array.from(this.idToWalletMap.keys()));

    if (rr || !users?.length) {
      this.log(rr?.message, "error", rr);
    }

    this.users = users;

    return { walletToIdMap: this.walletToIdMap, idToWalletMap: this.idToWalletMap, users };
  }

  commentContainsPermit(comment: string) {
    // aim to cover 3 known formats along with a claim_url
    const match = comment.match(/\*\*CLAIM (\d+(\.\d+)?) (XDAI|DAI|WXDAI)\*\*/g);
    const rematch = comment.match(/CLAIM (\d+(\.\d+)?) (XDAI|DAI|WXDAI)/g);
    const altMatch = comment.match(/\[\s*\[\s*(\d+(\.\d+)?)\s*(XDAI|DAI|WXDAI)\s*\]\]/g);
    const permitMatch = comment.match(/https:\/\/pay\.ubq\.fi\/?\?claim=[^\s]*/g);

    return !!(match || rematch || altMatch || permitMatch);
  }

  loader() {
    const steps = ["|", "/", "-", "\\"];
    let i = 0;
    return setInterval(() => {
      process.stdout.write(`\r${steps[i++]}`);
      i = i % steps.length;
    }, 100);
  }

  sanitizeClaimUrl(str: string) {
    // 37 permits failed to decode, below are the reasons why
    // `ifs` over `switch`/`else ifs` to ensure all possible sanitizations are applied

    if (str.includes('%3D&network=100"')) {
      str = str.split('%3D&network=100"')[0];
    }
    if (str.includes('\\">')) {
      str = str.split('\\">')[0];
    }
    if (str.includes('%3D"')) {
      str = str.split('%3D"')[0];
    }

    if (str.includes("%3D%3D")) {
      str = str.split("%3D%3D")[0];
    }
    if (str.includes("%3D&")) {
      str = str.split("%3D&")[0];
    }
    if (str.includes("&network")) {
      str = str.split("&network")[0];
    }
    if (str.includes('\\"')) {
      str = str.split('\\"')[0];
    }
    if (str.includes('">')) {
      str = str.split('">')[0];
    }

    if (str.includes('"')) {
      str = str.split('"')[0];
    }
    if (str.includes("%3D")) {
      str = str.split("%3D")[0];
    }
    if (str.includes(")")) {
      str = str.split(")")[0];
    }
    if (str.includes(">")) {
      str = str.split(">")[0];
    }
    if (str.includes("\\")) {
      str = str.split("\\")[0];
    }

    const sanityCheck = str.match(/[^A-Za-z0-9=]/g);

    if (sanityCheck) {
      this.log("Sanity check failed for permit: " + str);
      return;
    }

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

  log(message?: string, level: "info" | "error" = "info", obj?: object | null | unknown) {
    if (level === "info") {
      console.log(!obj ? message : message + " :: \n\n" + JSON.stringify(obj, null, 2));
    }
    if (level === "error") {
      console.error(!obj ? message : message + " :: \n\n" + JSON.stringify(obj, null, 2));
    }
  }
}

async function main() {
  const parser = new PaidIssueParser();
  await parser.run();
}

main()
  .catch(console.error)
  .finally(() => process.exit(0));

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
