#!/usr/bin/env bun
"use strict";
var __awaiter =
  (this && this.__awaiter) ||
  function (thisArg, _arguments, P, generator) {
    function adopt(value) {
      return value instanceof P
        ? value
        : new P(function (resolve) {
            resolve(value);
          });
    }
    return new (P || (P = Promise))(function (resolve, reject) {
      function fulfilled(value) {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      }
      function rejected(value) {
        try {
          step(generator["throw"](value));
        } catch (e) {
          reject(e);
        }
      }
      function step(result) {
        result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
      }
      step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
  };
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const fs_1 = require("fs");
const API_KEY = process.env.OPENAI_KEY;
const client = new sdk_1.default({
  apiKey: API_KEY,
});
const SYSTEM_PROMPT = `
You analyze and resolve Git merge conflicts automatically. When presented with code containing merge conflict markers (<<<<<<<, =======, >>>>>>>), I will:

1. Analyze conflicts:
   - Consider the HEAD version (current branch changes)
   - Examine the incoming version (changes being merged)
   - Project context and dependencies

2. Apply resolution rules:
   - For package.json:
     - Retain the name, version, description, main, author and license fields from the HEAD version without any changes.
     - Compare dependencies and devDependencies between the HEAD and incoming changes and always choose the latest version.
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
function resolveMergeConflict() {
  return __awaiter(this, void 0, void 0, function* () {
    try {
      // Retrieve the filename from command-line arguments
      const filename = process.argv[2];
      // Check if the filename argument is provided
      if (!filename) {
        console.error("Error: No filename provided.");
        console.error("Usage: bun index.ts <filename>");
        process.exit(1);
      }
      // Read the file content as a buffer
      const content = (0, fs_1.readFileSync)(filename);
      const response = yield client.messages.create({
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 8192,
        system: [
          {
            type: "text",
            text: "You are a seasoned software engineer. Your goal is to solve merge conflicts.\n",
          },
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: "Here is the input data. File name: " + filename + ". Content: " + content,
          },
        ],
      });
      // Write the resolved content back to the file
      if (!length(response.content) > 0) {
        console.error("Error: No filename provided.");
        console.error("Usage: bun index.ts <filename>");
        process.exit(1);
      }
      const text = response.content[0].text;
      (0, fs_1.writeFileSync)(filename, text + "\n");
    } catch (error) {
      console.error("Error resolving merge conflict:", error);
    }
  });
}
// Execute the function
resolveMergeConflict();
