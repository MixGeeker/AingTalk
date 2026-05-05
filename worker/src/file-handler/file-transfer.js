/**
 * FileTransfer - 文件传输处理
 * 支持文件发送（分块）、文件接收、文件验证
 * 分块大小：64KB
 * 文件保存到工作目录下的 received/ 文件夹
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');

// 分块大小: 64KB
const CHUNK_SIZE = 64 * 1024;

class FileTransfer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workDir = options.workDir || process.cwd();
    this.receivedDir = options.receivedDir || path.join(this.workDir, 'received');
    this.maxFileSize = options.maxFileSize || 104857600; // 100MB
    this.allowedFileTypes = options.allowedFileTypes || [
      '.zip', '.tar.gz', '.tgz', '.js', '.mjs', '.ts', '.py', '.json',
      '.md', '.txt', '.log', '.yaml', '.yml'
    ];

    this.maxConcurrentTransfers = options.maxConcurrentTransfers || 5;
    // 接收中的文件: fileId -> { chunks: Buffer[], received: Set, totalChunks, name, size }
    this.receivingFiles = new Map();
    // 发送中的文件: fileId -> { path, name, totalChunks, chunksSent: Set }
    this.sendingFiles = new Map();

    // 确保接收目录存在
    this.#ensureReceivedDir();
  }

  /**
   * 发送文件（分块读取）
   * @param {string} filePath - 文件路径
   * @param {string} [to] - 目标 Agent ID
   * @returns {Promise<Object>} 文件发送信息
   */
  async sendFile(filePath, to = null) {
    // 验证文件
    const validation = this.validateFile(filePath);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const fileId = uuidv4();
    const fileName = path.basename(filePath);
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

    console.log(`[FileTransfer] 准备发送文件: ${fileName} (${this.#formatBytes(fileSize)}, ${totalChunks} 块)`);

    // 记录发送状态
    this.sendingFiles.set(fileId, {
      path: filePath,
      name: fileName,
      size: fileSize,
      totalChunks,
      chunksSent: new Set(),
      startedAt: Date.now(),
      to
    });

    return {
      fileId,
      name: fileName,
      size: fileSize,
      mimeType: this.#getMimeType(fileName),
      totalChunks,
      chunkSize: CHUNK_SIZE
    };
  }

  /**
   * 读取文件块
   * @param {string} fileId - 文件 ID
   * @param {number} index - 块索引
   * @returns {Object|null} 块数据 { index, data (base64), isLast }
   */
  readChunk(fileId, index) {
    const fileInfo = this.sendingFiles.get(fileId);
    if (!fileInfo) {
      throw new Error(`文件发送任务不存在: ${fileId}`);
    }

    const { path: filePath, size, totalChunks } = fileInfo;
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, size);
    const chunkLength = end - start;

    if (start >= size) {
      return null; // 已读完
    }

    // 读取文件块
    const buffer = Buffer.alloc(chunkLength);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, chunkLength, start);
    } finally {
      fs.closeSync(fd);
    }

    fileInfo.chunksSent.add(index);

    return {
      fileId,
      index,
      total: totalChunks,
      data: buffer.toString('base64'),
      size: chunkLength,
      isLast: index === totalChunks - 1
    };
  }

  /**
   * 接收文件（开始接收流程）
   * @param {string} fileId - 文件 ID
   * @param {string} name - 文件名
   * @param {number} totalChunks - 总块数
   * @returns {Object} 接收状态
   */
  receiveFile(fileId, name, totalChunks) {
    // 限制并发接收数
    const activeReceives = [...this.receivingFiles.values()].filter(f => !f.completed).length;
    if (activeReceives >= this.maxConcurrentTransfers) {
      throw new Error(`并发接收数已达上限 (${this.maxConcurrentTransfers})`);
    }

    // 验证文件名和类型
    const validation = this.#validateFileName(name);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // 清理文件名（防止目录遍历）
    const safeName = this.#sanitizeFileName(name);
    const filePath = path.join(this.receivedDir, `${fileId}_${safeName}`);

    console.log(`[FileTransfer] 开始接收文件: ${safeName} (${totalChunks} 块)`);

    // 创建空文件
    this.#ensureReceivedDir();
    fs.writeFileSync(filePath, '');

    const receiveInfo = {
      fileId,
      name: safeName,
      originalName: name,
      path: filePath,
      totalChunks,
      receivedChunks: new Set(),
      chunks: [],
      startTime: Date.now(),
      completed: false
    };

    this.receivingFiles.set(fileId, receiveInfo);
    return receiveInfo;
  }

  /**
   * 处理接收到的文件块（按 index 缓存，全部到齐后按序写入）
   * @param {string} fileId - 文件 ID
   * @param {number} index - 块索引
   * @param {string} data - Base64 编码的块数据
   * @returns {Object} 处理结果 { success, complete, progress }
   */
  handleChunk(fileId, index, data) {
    const fileInfo = this.receivingFiles.get(fileId);
    if (!fileInfo) {
      return { success: false, error: '未找到接收任务', complete: false };
    }

    if (fileInfo.completed) {
      return { success: false, error: '文件已接收完成', complete: true };
    }

    // 检查重复块
    if (fileInfo.receivedChunks.has(index)) {
      return { success: true, duplicate: true, complete: false, progress: this.#getProgress(fileInfo) };
    }

    try {
      // 按 index 缓存块数据
      const buffer = Buffer.from(data, 'base64');

      // 检查总大小不超限
      const currentTotal = fileInfo.chunks.reduce((sum, c) => sum + (c ? c.length : 0), 0) + buffer.length;
      if (currentTotal > this.maxFileSize) {
        return { success: false, error: '文件大小超出限制', complete: false };
      }

      fileInfo.chunks[index] = buffer;
      fileInfo.receivedChunks.add(index);
      const progress = this.#getProgress(fileInfo);

      this.emit('chunk:received', { fileId, index, progress });

      // 全部收齐后按序写入
      if (fileInfo.receivedChunks.size === fileInfo.totalChunks) {
        // 按索引顺序拼接所有块
        const orderedBuffers = [];
        for (let i = 0; i < fileInfo.totalChunks; i++) {
          if (fileInfo.chunks[i]) {
            orderedBuffers.push(fileInfo.chunks[i]);
          }
        }
        const fullBuffer = Buffer.concat(orderedBuffers);
        fs.writeFileSync(fileInfo.path, fullBuffer);

        fileInfo.completed = true;
        fileInfo.endTime = Date.now();
        fileInfo.duration = fileInfo.endTime - fileInfo.startTime;
        fileInfo.finalSize = fullBuffer.length;
        fileInfo.chunks = null; // 释放缓存

        console.log(`[FileTransfer] 文件接收完成: ${fileInfo.name} (${this.#formatBytes(fullBuffer.length)}, ${fileInfo.duration}ms)`);

        this.emit('file:received', {
          fileId,
          name: fileInfo.name,
          path: fileInfo.path,
          size: fullBuffer.length,
          duration: fileInfo.duration
        });

        return { success: true, complete: true, progress: 100, fileInfo };
      }

      return { success: true, complete: false, progress };
    } catch (error) {
      console.error(`[FileTransfer] 处理块失败 [${fileId}:${index}]:`, error.message);
      return { success: false, error: error.message, complete: false };
    }
  }

  /**
   * 验证文件（类型和大小）
   * @param {string} filePath - 文件路径或文件名
   * @param {number} [expectedSize] - 预期大小
   * @returns {Object} 验证结果
   */
  validateFile(filePath, expectedSize) {
    const fileName = path.basename(filePath);

    // 检查文件是否存在（如果是路径）
    if (fs.existsSync(filePath)) {
      try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) {
          return { valid: false, error: '路径不是文件' };
        }

        // 检查大小
        if (stats.size > this.maxFileSize) {
          return {
            valid: false,
            error: `文件大小超出限制: ${this.#formatBytes(stats.size)} > ${this.#formatBytes(this.maxFileSize)}`
          };
        }
      } catch (error) {
        return { valid: false, error: `无法访问文件: ${error.message}` };
      }
    }

    // 检查文件类型
    const typeValidation = this.#validateFileName(fileName);
    if (!typeValidation.valid) {
      return typeValidation;
    }

    // 检查预期大小
    if (expectedSize && expectedSize > this.maxFileSize) {
      return {
        valid: false,
        error: `文件大小超出限制: ${this.#formatBytes(expectedSize)} > ${this.#formatBytes(this.maxFileSize)}`
      };
    }

    return { valid: true, fileName };
  }

  /**
   * 获取接收中的文件状态
   * @param {string} fileId - 文件 ID
   * @returns {Object|null}
   */
  getReceivingStatus(fileId) {
    const fileInfo = this.receivingFiles.get(fileId);
    if (!fileInfo) return null;

    return {
      fileId,
      name: fileInfo.name,
      totalChunks: fileInfo.totalChunks,
      receivedChunks: fileInfo.receivedChunks.size,
      progress: this.#getProgress(fileInfo),
      completed: fileInfo.completed
    };
  }

  /**
   * 获取发送中的文件状态
   * @param {string} fileId - 文件 ID
   * @returns {Object|null}
   */
  getSendingStatus(fileId) {
    const fileInfo = this.sendingFiles.get(fileId);
    if (!fileInfo) return null;

    return {
      fileId,
      name: fileInfo.name,
      totalChunks: fileInfo.totalChunks,
      sentChunks: fileInfo.chunksSent.size,
      progress: Math.round((fileInfo.chunksSent.size / fileInfo.totalChunks) * 100),
      completed: fileInfo.chunksSent.size === fileInfo.totalChunks
    };
  }

  /**
   * 清理已完成的传输任务
   */
  cleanup() {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 分钟

    for (const [fileId, fileInfo] of this.receivingFiles) {
      // 清理已完成或卡住超过 30 分的任务
      if (fileInfo.completed && (now - fileInfo.endTime) > maxAge) {
        this.receivingFiles.delete(fileId);
      } else if (!fileInfo.completed && (now - fileInfo.startTime) > maxAge) {
        // 卡住的传输：删除部分文件
        try { if (fs.existsSync(fileInfo.path)) fs.unlinkSync(fileInfo.path); } catch (e) { /* ignore */ }
        this.receivingFiles.delete(fileId);
        console.warn(`[FileTransfer] 清理卡住的接收任务: ${fileInfo.name} (${fileId})`);
      }
    }

    for (const [fileId, fileInfo] of this.sendingFiles) {
      if (fileInfo.chunksSent.size === fileInfo.totalChunks) {
        this.sendingFiles.delete(fileId);
      } else if ((now - (fileInfo.startedAt || 0)) > maxAge) {
        this.sendingFiles.delete(fileId);
      }
    }
  }

  /**
   * 获取已接收文件的列表
   * @returns {Array<Object>}
   */
  listReceivedFiles() {
    try {
      if (!fs.existsSync(this.receivedDir)) {
        return [];
      }

      const items = fs.readdirSync(this.receivedDir);
      return items
        .filter(item => {
          const itemPath = path.join(this.receivedDir, item);
          return fs.statSync(itemPath).isFile();
        })
        .map(item => {
          const itemPath = path.join(this.receivedDir, item);
          const stats = fs.statSync(itemPath);
          return {
            name: item.replace(/^[0-9a-f-]+_/, ''), // 去掉 fileId 前缀
            path: itemPath,
            size: stats.size,
            sizeFormatted: this.#formatBytes(stats.size),
            receivedAt: stats.mtime.toISOString()
          };
        });
    } catch (error) {
      return [];
    }
  }

  // ==================== 私有方法 ====================

  /**
   * 确保接收目录存在
   * @private
   */
  #ensureReceivedDir() {
    if (!fs.existsSync(this.receivedDir)) {
      fs.mkdirSync(this.receivedDir, { recursive: true });
      console.log(`[FileTransfer] 创建接收目录: ${this.receivedDir}`);
    }
  }

  /**
   * 验证文件名和类型
   * @private
   */
  #validateFileName(fileName) {
    // 安全检查：防止路径遍历
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      return { valid: false, error: '文件名包含非法字符' };
    }

    // Windows 保留设备名检查
    const winReserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
    const baseName = fileName.split('.')[0];
    if (winReserved.test(baseName)) {
      return { valid: false, error: '文件名包含保留设备名' };
    }

    // 禁止 NTFS 数据流
    if (fileName.includes(':$')) {
      return { valid: false, error: '文件名包含非法字符' };
    }

    // 检查文件扩展名
    const ext = this.#getFileExtension(fileName);
    if (!this.allowedFileTypes.includes(ext)) {
      return {
        valid: false,
        error: `不支持的文件类型: ${ext}。允许的类型: ${this.allowedFileTypes.join(', ')}`
      };
    }

    return { valid: true, ext };
  }

  /**
   * 获取文件扩展名（支持复合扩展名如 .tar.gz）
   * @private
   */
  #getFileExtension(fileName) {
    const lower = fileName.toLowerCase();
    for (const ext of this.allowedFileTypes) {
      if (lower.endsWith(ext)) {
        return ext;
      }
    }
    return path.extname(fileName).toLowerCase();
  }

  /**
   * 清理文件名
   * @private
   */
  #sanitizeFileName(fileName) {
    return fileName
      .replace(/[\/\\:*?"<>|]/g, '_') // 替换非法字符
      .replace(/\.\./g, '_'); // 防止目录遍历
  }

  /**
   * 获取 MIME 类型
   * @private
   */
  #getMimeType(fileName) {
    const ext = this.#getFileExtension(fileName);
    const mimeTypes = {
      '.zip': 'application/zip',
      '.tar.gz': 'application/gzip',
      '.tgz': 'application/gzip',
      '.js': 'application/javascript',
      '.ts': 'application/typescript',
      '.py': 'text/x-python',
      '.json': 'application/json',
      '.md': 'text/markdown',
      '.txt': 'text/plain',
      '.log': 'text/plain',
      '.yaml': 'application/x-yaml',
      '.yml': 'application/x-yaml'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * 获取接收进度
   * @private
   */
  #getProgress(fileInfo) {
    if (fileInfo.totalChunks === 0) return 0;
    return Math.round((fileInfo.receivedChunks.size / fileInfo.totalChunks) * 100);
  }

  /**
   * 格式化字节大小
   * @private
   */
  #formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
  }
}

module.exports = { FileTransfer, CHUNK_SIZE };
