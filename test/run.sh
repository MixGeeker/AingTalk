#!/usr/bin/env bash
#
# AingTalk 联调测试启动脚本
#
# 启动 Server + 2 Workers，运行测试编排器，自动清理。
# 用法: bash test/run.sh

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SERVER_URL="http://localhost:3000"
SERVER_PID=""
WORKER_ALPHA_PID=""
WORKER_BETA_PID=""
PIDS=()

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

cleanup() {
  echo ""
  echo -e "${YELLOW}[清理] 停止所有进程...${NC}"
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      echo "  已停止 PID: $pid"
    fi
  done
  # 强制清理残留
  sleep 2
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  echo -e "${GREEN}[清理] 完成${NC}"
}

trap cleanup EXIT INT TERM

# ===== Step 0: 清理残留进程 =====
echo -e "${YELLOW}[Step 0/5] 清理旧的 Server/Worker 进程...${NC}"
# 停掉所有可能的残留 node 进程 (仅 AingTalk 相关的)
pkill -f "node src/index.js" 2>/dev/null || true
sleep 2
echo "  完成"

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════╗"
echo "║      AingTalk 多 Agent 联调测试              ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"

# ===== Step 1: 启动 Server =====
echo -e "${YELLOW}[Step 1/5] 启动 Server...${NC}"

cd "$ROOT/server"
node src/index.js &
SERVER_PID=$!
PIDS+=("$SERVER_PID")
cd "$ROOT"

echo "  Server PID: $SERVER_PID"

# 等 Server 就绪（轮询 health endpoint）
echo -n "  等待 Server 就绪"
for i in $(seq 1 20); do
  if curl -s "$SERVER_URL/api/health" > /dev/null 2>&1; then
    echo ""
    echo -e "  ${GREEN}Server 已就绪 ✓${NC}"
    break
  fi
  echo -n "."
  sleep 1
done

if ! curl -s "$SERVER_URL/api/health" > /dev/null 2>&1; then
  echo ""
  echo -e "${RED}[错误] Server 启动超时（20 秒）${NC}"
  exit 1
fi

# ===== Step 2: 启动 Worker-Alpha =====
echo -e "${YELLOW}[Step 2/5] 启动 Worker-Alpha...${NC}"

mkdir -p "$ROOT/test/workers/alpha" "$ROOT/test/output"

cd "$ROOT/worker"
node src/index.js \
  --server "$SERVER_URL" \
  --name "Worker-Alpha" \
  --workDir "$ROOT/test/workers/alpha" \
  > "$ROOT/test/output/worker-alpha.log" 2>&1 &
WORKER_ALPHA_PID=$!
PIDS+=("$WORKER_ALPHA_PID")
cd "$ROOT"

echo "  Worker-Alpha PID: $WORKER_ALPHA_PID"
sleep 3

# 检查 Worker-Alpha 是否仍在运行
if ! kill -0 "$WORKER_ALPHA_PID" 2>/dev/null; then
  echo -e "${RED}[错误] Worker-Alpha 启动失败，查看日志:${NC}"
  tail -20 "$ROOT/test/output/worker-alpha.log"
  exit 1
fi
echo -e "  ${GREEN}Worker-Alpha 已启动 ✓${NC}"

# ===== Step 3: 启动 Worker-Beta =====
echo -e "${YELLOW}[Step 3/5] 启动 Worker-Beta...${NC}"

mkdir -p "$ROOT/test/workers/beta"

cd "$ROOT/worker"
node src/index.js \
  --server "$SERVER_URL" \
  --name "Worker-Beta" \
  --workDir "$ROOT/test/workers/beta" \
  > "$ROOT/test/output/worker-beta.log" 2>&1 &
WORKER_BETA_PID=$!
PIDS+=("$WORKER_BETA_PID")
cd "$ROOT"

echo "  Worker-Beta PID: $WORKER_BETA_PID"
sleep 3

if ! kill -0 "$WORKER_BETA_PID" 2>/dev/null; then
  echo -e "${RED}[错误] Worker-Beta 启动失败，查看日志:${NC}"
  tail -20 "$ROOT/test/output/worker-beta.log"
  exit 1
fi
echo -e "  ${GREEN}Worker-Beta 已启动 ✓${NC}"

# ===== Step 4: 等待 Agent 注册完成 =====
echo -e "${YELLOW}[Step 4/5] 等待 Agent 注册...${NC}"
sleep 5

# 验证 Agent 已注册
echo -n "  验证 Agent 列表"
for i in $(seq 1 15); do
  AGENT_COUNT=$(curl -s "$SERVER_URL/api/agents" | node -e "process.stdin.on('data', d => { try { const j = JSON.parse(d); console.log(j.count || 0); } catch(e) { console.log(0); } })")
  if [ "$AGENT_COUNT" -ge 2 ] 2>/dev/null; then
    echo ""
    echo -e "  ${GREEN}已注册 $AGENT_COUNT 个 Agent ✓${NC}"

    # 显示 Agent 详情
    curl -s "$SERVER_URL/api/agents" | node -e "
      process.stdin.on('data', d => {
        const data = JSON.parse(d);
        (data.agents || []).forEach(a => {
          console.error('    - ' + a.name + ' [' + a.status + '] ' + a.platform + '/' + a.arch);
        });
      });
    " 2>&1
    break
  fi
  echo -n "."
  sleep 2
done

if [ "$AGENT_COUNT" -lt 2 ] 2>/dev/null; then
  echo ""
  echo -e "${RED}[错误] Agent 注册不足 (当前: $AGENT_COUNT)，期望 >= 2${NC}"
  echo "Worker-Alpha 日志:"
  tail -20 "$ROOT/test/output/worker-alpha.log" 2>/dev/null || true
  echo "Worker-Beta 日志:"
  tail -20 "$ROOT/test/output/worker-beta.log" 2>/dev/null || true
  exit 1
fi

# ===== Step 5: 运行测试编排器 =====
echo -e "${YELLOW}[Step 5/5] 运行联调测试...${NC}"
echo ""

cd "$ROOT"
node test/orchestrator.mjs "$SERVER_URL"
TEST_EXIT_CODE=$?

echo ""
if [ $TEST_EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║   🎉 所有测试通过！多 Agent 通信正常        ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
else
  echo -e "${RED}╔══════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║   ❌ 测试失败！请检查日志                    ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════════╝${NC}"

  echo ""
  echo "=== Worker-Alpha 日志 (尾部) ==="
  tail -30 "$ROOT/test/output/worker-alpha.log" 2>/dev/null || true
  echo ""
  echo "=== Worker-Beta 日志 (尾部) ==="
  tail -30 "$ROOT/test/output/worker-beta.log" 2>/dev/null || true
fi

exit $TEST_EXIT_CODE
