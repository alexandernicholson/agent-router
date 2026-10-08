FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git unzip xz-utils python3 jq && rm -rf /var/lib/apt/lists/*
ARG NODE_VERSION=22.20.0
ARG BUN_VERSION=1.3.14
ARG PI_VERSION=1.0.4
ARG OMP_VERSION=18.8.0
RUN ARCH=$(dpkg --print-architecture | sed 's/amd64/x64/') \
 && curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz | tar -xJ -C /usr/local --strip-components=1
ENV BUN_INSTALL=/opt/bun
ENV PATH=/opt/bun/bin:$PATH
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
RUN npm install -g @earendil-works/pi-coding-agent@${PI_VERSION}
RUN bun install -g @oh-my-pi/pi-coding-agent@${OMP_VERSION}
RUN useradd -m -s /bin/bash agent
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && chmod -R a+rX /opt/bun
USER agent
WORKDIR /home/agent/work
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
