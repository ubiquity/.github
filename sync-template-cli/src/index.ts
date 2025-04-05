import OpenAI from "openai";
import { readFileSync, writeFileSync } from "fs";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const AI_MODEL = process.env.AI_MODEL || "anthropic/claude-3.7-sonnet";

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: OPENROUTER_API_KEY,
});

const SYSTEM_PROMPT = `
I analyze and resolve Git merge conflicts automatically. When presented with code containing merge conflict markers (<<<<<<<, =======, >>>>>>>), I will:

1. Analyze conflicts:
   - Consider the HEAD version (current branch changes)
   - Examine the incoming version (changes being merged)
   - Project context and dependencies

2. Apply resolution rules:
   - For package.json:
     - Retain the name, version, description, main, author and license fields from the HEAD version without any changes.
     - Compare dependencies and devDependencies between the HEAD and incoming changes and always choose the latest version.
     - If there is any duplicate dependency in the dependencies section, remove the duplicated one.
     - If there is any duplicate dependency in both the dependencies and devDependencies section, remove the one from the devDependencies.
     - For the remaining part, prefer the incoming changes.
   - For code files:
     - Preserve functionality from both versions.
     - Keep newer implementations when duplicated.
     - Maintain consistent style.
   - For github workflow files:
     - Preserve any environment variables set in the env field from the HEAD version.
     - For the remaining part, prefer changes from incoming changes.
   - For configuration files:
     - Keep project-specific settings from HEAD.
     - Add new options from incoming changes.

3. Output Requirements:
   - Provide only the full output code without any explanation. 
   - Ensure that each output file contains a new line (\n) at the end.
`;

async function resolveMergeConflict() {
  // Retrieve the filename from command-line arguments
  const filename = process.argv[2];

  // Check if the filename argument is provided
  if (!filename) {
    console.error("Error: No filename provided.");
    console.error("Usage: bun index.ts <filename>");
    process.exit(1);
  }

  // Read the file content as a buffer
  const content = readFileSync(filename);

  const response = await openai.chat.completions.create({
    model: AI_MODEL,
    messages: [
      {
        role: "system",
        content: [
          {
            type: "text",
            text: "You are a seasoned software engineer. Your goal is to solve merge conflicts.\n",
          },
          {
            type: "text",
            text: SYSTEM_PROMPT,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Here is the input data. File name: ${filename}. Content: ${content}`,
          },
        ],
      },
    ],
  });

  if (!response.choices || response.choices.length === 0) {
    throw new Error("Error: Received an empty response from the API.");
  }

  const text = response.choices[0].message.content;
  writeFileSync(filename, `${text}\n`);
}

resolveMergeConflict().catch((error) => {
  console.error("Error in resolveMergeConflict:", error);
  process.exit(1);
});
