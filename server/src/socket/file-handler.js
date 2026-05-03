/**
 * FileHandler - 文件传输处理
 * 处理文件传输请求、接受/拒绝、文件块传输和验证
 */
const { agentStore } = require('../services/agent-store');

// 分块大小: 64KB
const CHUNK_SIZE = 64 * 1024;

// 最大文件大小: 100MB
const MAX_FILE_SIZE = 100 * 1024 * 1024;

// 文件类型白名单
const ALLOWED_EXTENSIONS = [
  // 压缩包
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.7z', '.tar.gz', '.tar.bz2',
  // 代码文件
  '.js', '.ts', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h',
  // 数据文件
  '.json', '.xml', '.yaml', '.yml', '.csv', '.sql',
  // 文档
  '.md', '.txt', '.log'
];

// MIME 类型白名单
const ALLOWED_MIME_TYPES = [
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-7z-compressed',
  'application/x-bzip2',
  'text/plain',
  'text/javascript',
  'application/javascript',
  'text/typescript',
  'application/json',
  'text/yaml',
  'text/csv',
  'text/x-sql',
  'text/markdown',
  'text/xml'
];

// 禁止的文件类型
const FORBIDDEN_EXTENSIONS = ['.exe', '.dll', '.so', '.dylib', '.sh', '.bat', '.cmd', '.msi', '.apk', '.ipa'];

class FileHandler {
  constructor(io) {
    this.io = io;
  }

  /**
   * 处理文件传输请求
   * @param {Socket} socket - 发送方 socket
   * @param {Object} fileInfo - 文件信息
   */
  handleFileRequest(socket, fileInfo) {
    try {
      const { id, name, size, mimeType, from, to } = fileInfo;

      // 验证文件
      const validation = this.validateFile(name, mimeType, size);
      if (!validation.valid) {
        socket.emit('file:error', { fileId: id, error: validation.error });
        return { success: false, error: validation.error };
      }

      // 检查目标 Agent
      const targetAgent = agentStore.getAgent(to);
      if (!targetAgent) {
        socket.emit('file:error', { fileId: id, error: 'Target agent not found' });
        return { success: false, error: 'Target agent not found' };
      }

      if (targetAgent.status === 'offline') {
        socket.emit('file:error', { fileId: id, error: 'Target agent is offline' });
        return { success: false, error: 'Target agent is offline' };
      }

      // 计算分块数
      const totalChunks = Math.ceil(size / CHUNK_SIZE);

      // 创建传输记录
      const transfer = {
        id,
        name,
        size,
        mimeType,
        from,
        to,
        status: 'pending',
        chunksReceived: 0,
        totalChunks,
        chunkData: [], // 临时存储块数据
        savedPath: '',
        createdAt: Date.now(),
        completedAt: null
      };

      agentStore.addFileTransfer(transfer);

      // 通知接收方有文件传入
      this.io.to(targetAgent.socketId).emit('file:incoming', {
        fileId: id,
        name,
        size,
        mimeType,
        from,
        totalChunks,
        chunkSize: CHUNK_SIZE
      });

      // 通知发送方请求已处理
      socket.emit('file:request:ack', {
        fileId: id,
        status: 'pending',
        totalChunks,
        chunkSize: CHUNK_SIZE
      });

      console.log(`[FileHandler] File request: ${name} (${size} bytes, ${totalChunks} chunks) from ${from} to ${to}`);

      return { success: true, fileId: id, totalChunks };
    } catch (error) {
      console.error('[FileHandler] File request error:', error);
      socket.emit('file:error', { fileId: fileInfo.id, error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * 处理文件响应（接受/拒绝）
   * @param {Socket} socket - 接收方 socket
   * @param {Object} response - 响应信息
   */
  handleFileResponse(socket, response) {
    try {
      const { fileId, accepted } = response;
      const transfer = agentStore.getFileTransfer(fileId);

      if (!transfer) {
        socket.emit('file:error', { fileId, error: 'File transfer not found' });
        return { success: false, error: 'File transfer not found' };
      }

      if (accepted) {
        // 更新状态为传输中
        agentStore.updateFileTransfer(fileId, { status: 'transferring' });

        // 通知发送方可以开始传输
        const senderAgent = agentStore.getAgent(transfer.from);
        if (senderAgent && senderAgent.socketId) {
          this.io.to(senderAgent.socketId).emit('file:ready', {
            fileId,
            accepted: true,
            chunkSize: CHUNK_SIZE
          });
        }

        // 通知接收方准备接收
        socket.emit('file:ready', {
          fileId,
          accepted: true,
          totalChunks: transfer.totalChunks,
          chunkSize: CHUNK_SIZE
        });

        console.log(`[FileHandler] File accepted: ${transfer.name} (${fileId})`);
      } else {
        // 更新状态为拒绝
        agentStore.updateFileTransfer(fileId, { status: 'rejected' });

        // 通知发送方被拒绝
        const senderAgent = agentStore.getAgent(transfer.from);
        if (senderAgent && senderAgent.socketId) {
          this.io.to(senderAgent.socketId).emit('file:rejected', {
            fileId,
            reason: response.reason || 'Receiver declined'
          });
        }

        console.log(`[FileHandler] File rejected: ${transfer.name} (${fileId})`);
      }

      // 更新传输状态到前端
      this.io.emit('transfer:update', agentStore.getFileTransfer(fileId));

      return { success: true, accepted };
    } catch (error) {
      console.error('[FileHandler] File response error:', error);
      socket.emit('file:error', { fileId: response.fileId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * 处理文件块
   * @param {Socket} socket - 发送方 socket
   * @param {Object} chunk - 文件块数据
   */
  handleFileChunk(socket, chunk) {
    try {
      const { fileId, index, total, data } = chunk;
      const transfer = agentStore.getFileTransfer(fileId);

      if (!transfer) {
        socket.emit('file:error', { fileId, error: 'File transfer not found' });
        return { success: false, error: 'File transfer not found' };
      }

      if (transfer.status !== 'transferring') {
        socket.emit('file:error', { fileId, error: 'Transfer not in progress' });
        return { success: false, error: 'Transfer not in progress' };
      }

      // 验证块索引
      if (index < 0 || index >= total) {
        socket.emit('file:error', { fileId, error: `Invalid chunk index: ${index}` });
        return { success: false, error: 'Invalid chunk index' };
      }

      // 服务器仅转发，不存储块数据，避免内存堆积
      transfer.chunksReceived++;

      agentStore.updateFileTransfer(fileId, {
        chunksReceived: transfer.chunksReceived
      });

      // 发送块确认给发送方
      socket.emit('file:chunk:ack', { fileId, index });

      // 转发块给接收方
      const receiverAgent = agentStore.getAgent(transfer.to);
      if (receiverAgent && receiverAgent.socketId) {
        this.io.to(receiverAgent.socketId).emit('file:chunk', {
          fileId,
          index,
          total,
          data
        });
      }

      // 更新传输进度到前端
      this.io.emit('transfer:update', {
        ...agentStore.getFileTransfer(fileId),
        progress: Math.round((transfer.chunksReceived / total) * 100)
      });

      // 检查是否全部接收完成
      if (transfer.chunksReceived >= total) {
        this.handleTransferComplete(fileId);
      }

      return { success: true, index };
    } catch (error) {
      console.error('[FileHandler] File chunk error:', error);
      socket.emit('file:error', { fileId: chunk.fileId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * 处理传输完成
   * @param {string} fileId
   */
  handleTransferComplete(fileId) {
    const transfer = agentStore.getFileTransfer(fileId);
    if (!transfer) return;

    // 更新状态为完成，清空 chunkData
    agentStore.updateFileTransfer(fileId, {
      status: 'completed',
      completedAt: Date.now(),
      chunkData: null
    });

    // 通知发送方
    const senderAgent = agentStore.getAgent(transfer.from);
    if (senderAgent && senderAgent.socketId) {
      this.io.to(senderAgent.socketId).emit('file:complete', {
        fileId,
        success: true,
        name: transfer.name
      });
    }

    // 通知接收方
    const receiverAgent = agentStore.getAgent(transfer.to);
    if (receiverAgent && receiverAgent.socketId) {
      this.io.to(receiverAgent.socketId).emit('file:complete', {
        fileId,
        success: true,
        name: transfer.name
      });
    }

    // 广播到前端
    this.io.emit('transfer:update', agentStore.getFileTransfer(fileId));

    console.log(`[FileHandler] Transfer complete: ${transfer.name} (${fileId})`);
  }

  /**
   * 验证文件
   * @param {string} name - 文件名
   * @param {string} mimeType - MIME 类型
   * @param {number} size - 文件大小
   * @returns {Object} { valid, error? }
   */
  validateFile(name, mimeType, size) {
    // 检查文件名
    if (!name || typeof name !== 'string') {
      return { valid: false, error: 'Invalid file name' };
    }

    // 检查文件大小
    if (!size || size <= 0) {
      return { valid: false, error: 'Invalid file size' };
    }

    if (size > MAX_FILE_SIZE) {
      return { valid: false, error: `File size exceeds limit (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` };
    }

    // 获取扩展名
    const ext = this.getFileExtension(name).toLowerCase();

    // 检查禁止的扩展名
    if (FORBIDDEN_EXTENSIONS.includes(ext)) {
      return { valid: false, error: `File type not allowed: ${ext}` };
    }

    // 检查允许的扩展名
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return { valid: false, error: `Unsupported file type: ${ext}` };
    }

    // 检查 MIME 类型（仅当提供且非 octet-stream 时检查）
    if (mimeType && mimeType !== 'application/octet-stream' && !ALLOWED_MIME_TYPES.includes(mimeType)) {
      return { valid: false, error: `Unsupported MIME type: ${mimeType}` };
    }

    return { valid: true };
  }

  /**
   * 获取文件扩展名（支持 .tar.gz 等多部分扩展名）
   * @param {string} filename
   * @returns {string}
   */
  getFileExtension(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.tar.gz')) {
      return '.tar.gz';
    }
    if (lower.endsWith('.tar.bz2')) {
      return '.tar.bz2';
    }
    if (lower.endsWith('.tgz')) {
      return '.tgz';
    }
    const idx = filename.lastIndexOf('.');
    return idx > 0 ? filename.slice(idx).toLowerCase() : '';
  }

  /**
   * 处理传输错误
   * @param {string} fileId
   * @param {string} error
   */
  handleTransferError(fileId, error) {
    const transfer = agentStore.getFileTransfer(fileId);
    if (transfer) {
      agentStore.updateFileTransfer(fileId, { status: 'failed' });

      // 通知双方
      const senderAgent = agentStore.getAgent(transfer.from);
      const receiverAgent = agentStore.getAgent(transfer.to);

      if (senderAgent && senderAgent.socketId) {
        this.io.to(senderAgent.socketId).emit('file:error', { fileId, error });
      }
      if (receiverAgent && receiverAgent.socketId) {
        this.io.to(receiverAgent.socketId).emit('file:error', { fileId, error });
      }

      this.io.emit('transfer:update', agentStore.getFileTransfer(fileId));
    }
  }
}

module.exports = {
  FileHandler,
  CHUNK_SIZE,
  MAX_FILE_SIZE,
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  FORBIDDEN_EXTENSIONS
};
