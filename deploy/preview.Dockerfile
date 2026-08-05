FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /home/agent/sandking

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY README.md ./

# Preview machine stays idle until we launch Cockpit ourselves over `fly ssh console`,
# same pattern as .sandcastle/Dockerfile's bootstrap sandbox.
ENTRYPOINT ["sleep", "infinity"]
