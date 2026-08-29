# Codex CLI — uses your existing login on a trusted local machine
npx --yes github:AgentsKit-io/code-review-cli --provider codex-cli --mode trusted-local

# Claude CLI — uses your existing login
npx --yes github:AgentsKit-io/code-review-cli --provider claude-cli

# OpenAI API
OPENAI_API_KEY=... npx --yes github:AgentsKit-io/code-review-cli \
  --provider openai --model gpt-4o
