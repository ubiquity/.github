import anthropic
import sys

filename = sys.argv[1]

output = b''
with open(filename, 'rb') as file:
    output = file.read()

client = anthropic.Anthropic()

prompt = """

I analyze and resolve Git merge conflicts automatically. When presented with code containing merge conflict markers (<<<<<<<, =======, >>>>>>>), I will:

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

Here is the input data.
"""

message = client.messages.create(
    model="claude-3-7-sonnet-20250219",
    max_tokens=8192,
    temperature=0,
    system="You are a seasoned software engineer.",
    messages=[
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": prompt + "File name: " + str(filename) + ". Content: " + str(output),
                }
            ],
        }
    ],
)

if message and isinstance(message.content, list) and message.content:
  text = getattr(message.content[0], "text", None)
  if isinstance(text, str):
    with open(filename, 'w') as file:
      file.write(text + '\n')

