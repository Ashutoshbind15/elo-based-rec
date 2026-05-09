# syntax=docker/dockerfile:1.7

ARG UBUNTU_VERSION=20.04
ARG NODE_VERSION=20.19.0
ARG LC0_REF=v0.32.1

FROM ubuntu:${UBUNTU_VERSION} AS lc0-builder

ARG DEBIAN_FRONTEND=noninteractive
ARG LC0_REF

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    gcc-10 \
    g++-10 \
    python3-pip \
    zlib1g \
    zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir meson ninja

WORKDIR /tmp

RUN git clone --branch "${LC0_REF}" --depth 1 --recurse-submodules \
  https://github.com/LeelaChessZero/lc0.git lc0-src

WORKDIR /tmp/lc0-src

RUN CC=gcc-10 CXX=g++-10 INSTALL_PREFIX=/opt/lc0 ./build.sh release -Dgtest=false -Db_lto=false

FROM ubuntu:${UBUNTU_VERSION} AS runtime

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_VERSION
ARG MAIA_DEFAULT_LEVEL=1100

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    libgomp1 \
    libstdc++6 \
    xz-utils \
    zlib1g \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  | tar -xJ -C /usr/local --strip-components=1

COPY --from=lc0-builder /opt/lc0 /opt/lc0

RUN mkdir -p /opt/lc0/weights \
  && for level in 1100 1200 1300 1400 1500 1600 1700 1800 1900; do \
    curl -fsSL \
      "https://github.com/CSSLab/maia-chess/releases/download/v1.0/maia-${level}.pb.gz" \
      -o "/opt/lc0/weights/maia-${level}.pb.gz"; \
  done

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN corepack enable \
  && pnpm install --frozen-lockfile --prod

COPY src ./src

ENV NODE_ENV=production
ENV MAIA_DEFAULT_LEVEL=${MAIA_DEFAULT_LEVEL}
ENV PORT=8787
ENV LC0_EAGER_INIT=true
ENV LC0_BINARY=/opt/lc0/bin/lc0
ENV LC0_CWD=/opt/lc0
ENV LC0_LEVELS=1100,1200,1300,1400,1500,1600,1700,1800,1900
ENV LC0_WEIGHTS_DIR=/opt/lc0/weights
ENV LC0_NODES=1
ENV LC0_TIMEOUT_MS=30000
ENV PATH=/opt/lc0/bin:/usr/local/bin:${PATH}

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "src/server.js"]
