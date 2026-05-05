FROM node:20-alpine

# node-pty 需要编译工具
RUN apk add --no-cache python3 make g++

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY package.json ./

RUN pnpm install --prod && \
    apk del python3 make g++ && \
    rm -rf /var/cache/apk/*

COPY src/ ./src/
COPY scripts/ ./scripts/

# mcp-server 可以以两种模式运行:
#   full 模式 (默认):  Worker + MCP Server，接收任务
#   mcp-only 模式:     纯 MCP Server，仅为本地 CC 提供工具
# 通过环境变量控制:
#   AINGTALK_SERVER_URL  - AingTalk Server 地址
#   AGENT_NAME           - Agent 名称 (默认 hostname)
#   AINGTALK_MODE        - 运行模式: full | mcp-only (默认 full)

ENV AINGTALK_SERVER_URL=http://agent-server:3000

# 默认以 full 模式运行 mcp-server
CMD ["node", "src/mcp-server.mjs"]

# 旧版 Worker (向后兼容): CMD ["node", "src/index.js"]
