//@ts-check
module.exports = async function printDeploymentsLogs({ github, context, fs, customDomain }) {
  const pullRequestInfo = fs.readFileSync("./pr_number").toString("utf-8");
  console.log({ pullRequestInfo });
  const infoSubstring = pullRequestInfo.split(",");
  const eventName = infoSubstring[0].split("=")[1];
  const pullRequestNumber = infoSubstring[1].split("=")[1] ?? 0;
  const commitSha = infoSubstring[2].split("=")[1];
  const deploymentsLog = fs.readFileSync("./deployments.log").toString("utf-8");

  let defaultBody = deploymentsLog;
  let uniqueDeployUrl = deploymentsLog.match(/https:\/\/.+\.pages\.dev/gim);
  const botCommentsArray = [];

  if (uniqueDeployUrl) {
    if (customDomain) {
      uniqueDeployUrl = uniqueDeployUrl[0].replace(/\..+$/, `.${customDomain}`);
    }
    const slicedSha = commitSha.slice(0, -33);

    defaultBody = `<a href="${uniqueDeployUrl}"><code>${slicedSha}</code></a>`;
  }

  function verifyInput(data) {
    return data !== "";
  };

  function alignRight(bodyData) {
    if (!bodyData.startsWith('<div align="right">')) {
      return `<div align="right">${bodyData}</div>`;
    } else {
      return bodyData;
    }
  };

  async function createNewCommitComment(body = defaultBody) {
    verifyInput(body) &&
      (await github.rest.repos.createCommitComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        commit_sha: commitSha,
        body: alignRight(body),
      }));
  };

  async function createNewPullRequestComment(body = defaultBody) {
    verifyInput(body) &&
      (await github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: pullRequestNumber,
        body: alignRight(body),
      }));
  };

  async function editExistingPullRequestComment() {
    const { body: botBody, id: commentId } = botCommentsArray[0];
    let commentBody = alignRight(`${(botBody)}\n`) + alignRight(`${(defaultBody)}`);
    verifyInput(commentBody) &&
      (await github.rest.issues.updateComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: commentId,
        body: commentBody,
      }));
  };

  async function deleteExistingPullRequestComments() {
    const delPromises = botCommentsArray.map(async function (elem) {
      await github.rest.issues.deleteComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: elem.id,
      });
    });
    await Promise.all(delPromises);
  };

  async function mergeExistingPullRequestComments() {
    let commentBody = alignRight(`${(defaultBody)}\n`);
    botCommentsArray.forEach(({ body }) => {
      commentBody = commentBody + alignRight(`${(body)}\n`);
    });
    await createNewPullRequestComment(commentBody);
    await deleteExistingPullRequestComments();
  }

  async function processPullRequestComments() {
    const perPage = 30;
    let pageNumber = 1;
    let hasMore = true;
    const commentsArray = [];

    while (hasMore) {
      const { data: issueComments } = await github.rest.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: pullRequestNumber,
        per_page: perPage,
        page: pageNumber,
      });
      pageNumber++;

      if (issueComments.length > 0) {
        commentsArray.push(...issueComments);
      } else {
        hasMore = false;
      }
    }

    if (commentsArray.length > 0) {
      commentsArray.forEach((elem) => {
        if (elem.user.type === "Bot" && elem.user.login === "ubiquibot[bot]") {
          botCommentsArray.push(elem);
        }
      });
      const botLen = botCommentsArray.length;
      switch (botLen) {
        case 0:
          //no (bot) comments
          createNewPullRequestComment();
          break;
        case 1:
          //single (bot) comment []
          editExistingPullRequestComment();
          break;
        default:
          //multiple (bot) comments []
          mergeExistingPullRequestComments();
          break;
      }
    } else {
      //no comments (user|bot) []
      createNewPullRequestComment();
    }
  }

  if (eventName == "pull_request") {
    console.log("Creating a comment for the pull request");
    await processPullRequestComments();
  } else {
    console.log("Creating a comment for the commit");
    await createNewCommitComment();
  }
};
