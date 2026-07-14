# Codex CLI — uses your existing login
npx --yes github:AgentsKit-io/code-review-cli --provider codex-cli

# Claude CLI — uses your existing login
npx --yes github:AgentsKit-io/code-review-cli --provider claude-cli

# OpenAI API
OPENAI_API_KEY=... npx --yes github:AgentsKit-io/code-review-cli \
  --provider openai --model gpt-4o
