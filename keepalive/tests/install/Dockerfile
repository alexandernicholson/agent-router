FROM ubuntu:24.04
RUN apt-get update -qq && apt-get install -y -qq curl ca-certificates git python3 >/dev/null && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null && apt-get install -y -qq nodejs >/dev/null
RUN npm i -g @anthropic-ai/claude-code >/dev/null 2>&1 && claude --version
RUN useradd -m tester
USER tester
WORKDIR /home/tester
