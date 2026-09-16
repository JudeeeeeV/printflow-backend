const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fetch = require('node-fetch');
const { AGENT_VERSION } = require('./config');
const logger = require('./logger');

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

class JobProcessor {
  constructor(printerService, emitStatus) {
    this.printerService = printerService;
    this.emitStatus = emitStatus;
    this.queue = Promise.resolve();
    this.recentJobs = new Map();
  }

  enqueue(payload) {
    this.queue = this.queue
      .then(() => this.processBatch(payload))
      .catch((error) =>
        logger.error(`Batch processing failed: ${error.message}`),
      );
  }

  async processBatch(payload) {
    if (
      !payload ||
      !Array.isArray(payload.orders) ||
      payload.orders.length > 100
    ) {
      logger.warn('Rejected an invalid batch payload');
      return;
    }
    const printerName =
      typeof payload.printerName === 'string' ? payload.printerName : undefined;
    if (!this.printerService.has(printerName)) {
      for (const order of payload.orders) this.report(order?.id, 'FAILED');
      logger.warn('Rejected batch because its selected printer is unavailable');
      return;
    }
    for (const order of payload.orders) {
      await this.processOrder(order, printerName);
    }
  }

  async processOrder(order, printerName) {
    if (
      !order ||
      typeof order.id !== 'string' ||
      typeof order.file_url !== 'string'
    ) {
      return;
    }
    this.removeOldJobMarkers();
    if (this.recentJobs.has(order.id)) {
      logger.warn(`Ignored duplicate print job ${order.id}`);
      return;
    }
    this.recentJobs.set(order.id, Date.now());

    const tempDirectory = path.join(os.tmpdir(), 'PrintFlow');
    const tempFile = path.join(tempDirectory, `${randomUUID()}.pdf`);
    try {
      fs.mkdirSync(tempDirectory, { recursive: true });
      this.report(order.id, 'DOWNLOADING');
      const response = await fetch(order.file_url, {
        signal: AbortSignal.timeout(120_000),
        headers: { 'User-Agent': `PrintFlow-Agent/${AGENT_VERSION}` },
      });
      if (!response.ok)
        throw new Error(`Document download failed (${response.status})`);
      const declaredSize = Number(response.headers.get('content-length') || 0);
      if (declaredSize > MAX_DOCUMENT_BYTES)
        throw new Error('Document is too large');
      const document = await response.buffer();
      if (document.length === 0 || document.length > MAX_DOCUMENT_BYTES) {
        throw new Error('Document is empty or too large');
      }
      if (document.subarray(0, 4).toString('ascii') !== '%PDF') {
        throw new Error(
          'Only PDF print jobs are supported by the printer agent',
        );
      }
      fs.writeFileSync(tempFile, document, { flag: 'wx' });
      this.report(order.id, 'SENT_TO_SPOOLER');
      await this.printerService.print(tempFile, {
        printerName,
        monochrome: order.print_color_mode === 'BLACK_AND_WHITE',
      });
      this.report(order.id, 'COMPLETED');
      logger.info(`Print job ${order.id} was dispatched successfully`);
    } catch (error) {
      this.report(order.id, 'FAILED');
      logger.error(`Print job ${order.id} failed: ${error.message}`);
    } finally {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (error) {
        logger.warn(`Temporary print file cleanup failed: ${error.message}`);
      }
    }
  }

  report(orderId, status) {
    if (typeof orderId === 'string') this.emitStatus({ orderId, status });
  }

  removeOldJobMarkers() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [orderId, time] of this.recentJobs) {
      if (time < cutoff) this.recentJobs.delete(orderId);
    }
  }
}

module.exports = { JobProcessor };
