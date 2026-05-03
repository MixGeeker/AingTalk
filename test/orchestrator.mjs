/**
 * AingTalk 联调测试编排器
 *
 * 测试流程:
 *   Phase 1: Agent 注册与发现
 *   Phase 2: 消息互通 (Agent → Agent)
 *   Phase 3: Claude Code 远程任务分发与执行
 *
 * 用法: node test/orchestrator.mjs [serverUrl]
 */

import { io } from 'socket.io-client';
import crypto from 'node:crypto';

function uuidv4() {
  return crypto.randomUUID();
}

const SERVER_URL = process.argv[2] || 'http://localhost:3000';

// ==================== 测试工具 ====================

const results = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  results.push({ name, status: 'pending' });
  return async () => {
    process.stderr.write(`\n  🧪 ${name}... `);
    try {
      await fn();
      results.find(r => r.name === name).status = 'pass';
      passed++;
      process.stderr.write('✅ PASS\n');
    } catch (err) {
      results.find(r => r.name === name).status = 'fail';
      results.find(r => r.name === name).error = err.message;
      failed++;
      process.stderr.write(`❌ FAIL: ${err.message}\n`);
    }
  };
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 测试主流程 ====================

async function main() {
  console.error('═'.repeat(52));
  console.error('  AingTalk 联调测试');
  console.error('═'.repeat(52));
  console.error(`  Server: ${SERVER_URL}`);
  console.error(`  Time:   ${new Date().toISOString()}`);
  console.error('═'.repeat(52));

  // ---- 连接到 Server ----
  const socket = io(SERVER_URL, {
    transports: ['websocket', 'polling'],
    timeout: 10000,
    reconnection: false
  });

  const orchestratorId = `orch-${Date.now()}`;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接 Server 超时 (10s)')), 10000);
    socket.on('connect', () => {
      clearTimeout(timer);
      console.error(`\n[Orchestrator] 已连接, ID: ${socket.id}`);
      resolve();
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`连接失败: ${err.message}`));
    });
  });

  // 监听事件
  let agentList = [];
  const messages = [];
  let claudeResults = {};

  socket.on('agent:list', (list) => {
    agentList = list || [];
  });

  socket.on('message:new', (msg) => {
    messages.push(msg);
  });

  socket.on('claude:execute:result', (data) => {
    claudeResults[data.requestId] = data;
  });

  socket.on('claude:execute:error', (data) => {
    claudeResults[data.requestId] = { error: data.error };
  });

  // 请求初始状态 — 同时用多种方式确保拿到 Agent 列表
  socket.emit('dashboard:join', { timestamp: Date.now() });
  socket.emit('agent:list:request');
  await sleep(1000);

  // 如果还没拿到，重试 agent:list:request
  if (agentList.length === 0) {
    console.error('[Orchestrator] 未收到 agent:list，重试...');
    for (let i = 0; i < 5 && agentList.length === 0; i++) {
      socket.emit('agent:list:request');
      await sleep(1000);
    }
  }

  if (agentList.length === 0) {
    console.error('[Orchestrator] 警告: 仍未收到 agent:list，尝试通过 REST API 获取');
    try {
      const resp = await fetch(`${SERVER_URL}/api/agents`);
      const data = await resp.json();
      if (data.agents) {
        agentList = data.agents;
        console.error(`[Orchestrator] 通过 REST API 获取到 ${agentList.length} 个 Agent`);
      }
    } catch (e) {
      console.error(`[Orchestrator] REST API 也失败: ${e.message}`);
    }
  }

  console.error(`[Orchestrator] Agent 列表: ${agentList.length} 个`);
  agentList.forEach(a => console.error(`  - ${a.name} (${a.id}) [${a.status}]`));

  // ==================== Phase 1: Agent 注册与发现 ====================

  console.error('\n━━━ Phase 1: Agent 注册与发现 ━━━');

  await test('Step 1.1: 等待 Agent 注册 (Worker-Alpha, Worker-Beta)', async () => {
    // 等待最多 30 秒，每 2 秒检查一次（同时用 socket 和 REST API）
    for (let i = 0; i < 15; i++) {
      socket.emit('agent:list:request');

      // 同时通过 REST API 获取
      try {
        const resp = await fetch(`${SERVER_URL}/api/agents`);
        const data = await resp.json();
        if (data.agents && data.agents.length > 0) {
          agentList = data.agents;
        }
      } catch (_) {}

      await sleep(2000);

      const names = agentList.map(a => a.name);
      if (names.includes('Worker-Alpha') && names.includes('Worker-Beta')) {
        const online = agentList.filter(a => a.status === 'online' || a.status === 'idle');
        console.error(`\n      发现 ${agentList.length} 个 Agent (在线: ${online.length})`);
        agentList.forEach(a => {
          console.error(`        - ${a.name} (${a.id}) [${a.status}] ${a.platform}/${a.arch}`);
        });
        return;
      }
    }
    throw new Error(`等待超时。当前 Agent: ${agentList.map(a => a.name).join(', ') || '(无)'}`);
  })();

  await test('Step 1.2: 两个 Agent 均为在线状态', async () => {
    const alpha = agentList.find(a => a.name === 'Worker-Alpha');
    const beta = agentList.find(a => a.name === 'Worker-Beta');
    assert(alpha, 'Worker-Alpha 未找到');
    assert(beta, 'Worker-Beta 未找到');
    assert(
      alpha.status === 'online' || alpha.status === 'idle',
      `Worker-Alpha 状态异常: ${alpha.status}`
    );
    assert(
      beta.status === 'online' || beta.status === 'idle',
      `Worker-Beta 状态异常: ${beta.status}`
    );
  })();

  await test('Step 1.3: Agent 具备 claude-code 能力', async () => {
    const beta = agentList.find(a => a.name === 'Worker-Beta');
    assert(beta, 'Worker-Beta 未找到');
    assert(
      beta.capabilities && beta.capabilities.includes('claude-code'),
      `Worker-Beta 缺少 claude-code 能力: ${JSON.stringify(beta.capabilities)}`
    );
  })();

  // ==================== Phase 2: 消息互通 ====================

  console.error('\n━━━ Phase 2: 消息互通 ━━━');

  const testMsgId1 = `test-msg-${Date.now()}-1`;
  await test('Step 2.1: 发送消息 Alpha → Beta', async () => {
    // 通过 REST API 确保拿到 Agent
    const resp = await fetch(`${SERVER_URL}/api/agents`);
    const data = await resp.json();
    const agents = data.agents || [];
    const alpha = agents.find(a => a.name === 'Worker-Alpha');
    const beta = agents.find(a => a.name === 'Worker-Beta');
    assert(alpha, 'Worker-Alpha 未找到');
    assert(beta, 'Worker-Beta 未找到');

    // 通过 send-message 事件发送（模拟 Frontend/MCP 发送）
    socket.emit('send-message', {
      id: testMsgId1,
      from: alpha.id,
      fromName: 'Worker-Alpha',
      to: beta.id,
      type: 'text',
      content: '你好 Beta，这是来自 Alpha 的联调测试消息！',
      timestamp: Date.now()
    });

    // 等待消息投递
    await sleep(2000);

    // 检查消息是否已投递（通过 REST API）
    try {
      const resp = await fetch(`${SERVER_URL}/api/agents/${beta.id}/messages?limit=20`);
      const data = await resp.json();
      const found = data.messages?.find(m => m.id === testMsgId1);
      assert(found, '消息未找到于 Beta 的消息历史中');
      assert(found.type === 'text', `消息类型错误: ${found.type}`);
      console.error(`\n      消息已投递: "${found.content}"`);
    } catch (e) {
      throw new Error(`REST API 查询失败: ${e.message}`);
    }
  })();

  const testMsgId2 = `test-msg-${Date.now()}-2`;
  await test('Step 2.2: 发送消息 Beta → Alpha (回复)', async () => {
    const resp = await fetch(`${SERVER_URL}/api/agents`);
    const data = await resp.json();
    const agents = data.agents || [];
    const alpha = agents.find(a => a.name === 'Worker-Alpha');
    const beta = agents.find(a => a.name === 'Worker-Beta');

    socket.emit('send-message', {
      id: testMsgId2,
      from: beta.id,
      fromName: 'Worker-Beta',
      to: alpha.id,
      type: 'text',
      content: '收到！Beta 运行正常，联调测试继续。',
      timestamp: Date.now()
    });

    await sleep(2000);

    const resp2 = await fetch(`${SERVER_URL}/api/agents/${alpha.id}/messages?limit=20`);
    const data2 = await resp2.json();
    const found = data2.messages?.find(m => m.id === testMsgId2);
    assert(found, '回复消息未投递到 Alpha');
    console.error(`\n      回复已投递: "${found.content}"`);
  })();

  await test('Step 2.3: 广播消息', async () => {
    const testBroadcastId = `test-broadcast-${Date.now()}`;
    socket.emit('send-message', {
      id: testBroadcastId,
      from: orchestratorId,
      fromName: 'TestOrchestrator',
      to: 'broadcast',
      type: 'text',
      content: '📢 广播测试: 所有 Agent 请回复状态',
      timestamp: Date.now()
    });

    await sleep(2000);

    // 验证广播消息被存储
    const resp = await fetch(`${SERVER_URL}/api/messages?limit=50`);
    const data = await resp.json();
    const found = data.messages?.find(m => m.id === testBroadcastId);
    assert(found, '广播消息未被存储');
    assert(found.to === 'broadcast', `消息未标记为 broadcast: ${found.to}`);
  })();

  // ==================== Phase 3: Claude Code 任务分发 ====================

  console.error('\n━━━ Phase 3: Claude Code 远程任务分发 ━━━');

  const taskId = `test-task-${Date.now()}`;
  const requestId = uuidv4();

  await test('Step 3.1: 发送 claude:execute 请求到 Worker-Beta', async () => {
    const resp = await fetch(`${SERVER_URL}/api/agents`);
    const data = await resp.json();
    const beta = (data.agents || []).find(a => a.name === 'Worker-Beta');
    assert(beta, 'Worker-Beta 未找到');

    console.error(`\n      目标: ${beta.name} (${beta.id})`);
    console.error(`      任务: ${taskId}`);
    console.error(`      Prompt: "请用一句话介绍你自己，包括你的平台和架构信息"`);

    socket.emit('claude:execute:request', {
      requestId,
      targetAgentId: beta.id,
      taskId,
      prompt: '请用一句话介绍你自己，包括你的平台和架构信息',
      context: {
        cwd: beta.workDir || process.cwd(),
        files: [],
        environment: {}
      },
      timeout: 120000, // 2 minutes should be enough
      fromAgentId: orchestratorId
    });

    // 等待结果 (最多 130 秒)
    for (let i = 0; i < 65; i++) {
      await sleep(2000);
      if (claudeResults[requestId]) {
        break;
      }
      if (i % 5 === 0) {
        process.stderr.write('.');
      }
    }

    const result = claudeResults[requestId];
    assert(result, '未收到 Claude Code 执行结果 (超时)');

    if (result.error) {
      throw new Error(`Claude Code 执行失败: ${result.error}`);
    }

    assert(
      typeof result.exitCode === 'number',
      `exitCode 缺失或类型错误: ${result.exitCode}`
    );

    console.error(`\n`);
    console.error(`      退出码: ${result.exitCode}`);
    console.error(`      耗时: ${result.duration}ms (${(result.duration / 1000).toFixed(1)}s)`);
    console.error(`      摘要: ${(result.summary || '').substring(0, 120)}`);
  })();

  await test('Step 3.2: 验证任务执行结果质量', async () => {
    const result = claudeResults[requestId];
    assert(result, '无执行结果');

    if (result.exitCode !== 0) {
      throw new Error(`exitCode 非零: ${result.exitCode}, 摘要: ${result.summary}`);
    }

    assert(result.duration > 0, '耗时应 > 0');
    assert(result.summary && result.summary.length > 0, '摘要不应为空');
  })();

  // ==================== Phase 4: 系统健康检查 ====================

  console.error('\n━━━ Phase 4: 系统健康检查 ━━━');

  await test('Step 4.1: REST API 健康检查正常', async () => {
    const resp = await fetch(`${SERVER_URL}/api/health`);
    const data = await resp.json();
    assert(data.success, '健康检查失败');
    assert(data.status === 'healthy', `状态异常: ${data.status}`);
    assert(data.agents.total >= 2, `Agent 数量异常: ${data.agents.total}`);
    console.error(`\n      总 Agent: ${data.agents.total}, 在线: ${data.agents.online}`);
    console.error(`      消息总数: ${data.messages}, 运行时间: ${data.uptimeHuman}`);
  })();

  await test('Step 4.2: Agent 列表 API 正常', async () => {
    const resp = await fetch(`${SERVER_URL}/api/agents`);
    const data = await resp.json();
    assert(data.success, 'API 调用失败');
    assert(data.count >= 2, `Agent 数量: ${data.count}`);
  })();

  // ==================== 报告 ====================

  console.error('\n' + '═'.repeat(52));
  console.error('  测试报告');
  console.error('═'.repeat(52));

  for (const r of results) {
    const icon = r.status === 'pass' ? '✅' : '❌';
    const err = r.error ? ` — ${r.error}` : '';
    console.error(`  ${icon} ${r.name}${err}`);
  }

  console.error('─'.repeat(52));
  console.error(`  总计: ${results.length} | 通过: ${passed} | 失败: ${failed}`);
  console.error('═'.repeat(52));

  // 清理
  socket.disconnect();

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n❌ 测试异常: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
