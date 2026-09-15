const io = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const ptp = require('pdf-to-printer');

const SHOP_ID = process.argv[2];
const ACCESS_TOKEN = process.env.PRINTFLOW_DAEMON_ACCESS_TOKEN;
if (!SHOP_ID || !ACCESS_TOKEN) {
  console.error('Shop ID and an authenticated daemon session are required.');
  process.exit(1);
}

const URL = `${process.env.PRINTFLOW_BACKEND_URL || 'http://localhost:3000'}/daemon`;
console.log(`Starting PHYSICAL Print Daemon for shop: ${SHOP_ID}`);

const socket = io(URL, {
  query: { shopId: SHOP_ID, role: 'daemon' },
  auth: { token: ACCESS_TOKEN },
});

socket.on('connect', async () => {
  console.log(
    `[CONNECTED] Physical Daemon Online with socket ID: ${socket.id}`,
  );

  try {
    const printers = await ptp.getPrinters();
    const printerNames = printers.map((p) => p.name);
    console.log(`    Found ${printerNames.length} printers.`);
    socket.emit('daemon_printers_update', { printers: printerNames });
  } catch (error) {
    console.error('    Failed to fetch printers:', error.message);
  }
});

socket.on('disconnect', () => {
  console.log('[DISCONNECTED] Physical Daemon Offline');
});

socket.on('batch_execute', async (payload) => {
  console.log('\n=======================================');
  console.log(`[BATCH RECEIVED] Spooling ${payload.orders.length} orders...`);
  console.log('=======================================\n');

  const { orders } = payload;
  if (!orders || !Array.isArray(orders)) {
    console.error('Invalid payload format');
    return;
  }

  for (const order of orders) {
    try {
      console.log(`>>> Processing Order ${order.id}`);

      // 1. Downloading
      socket.emit('job_status_update', {
        orderId: order.id,
        status: 'DOWNLOADING',
      });
      console.log('    Status -> DOWNLOADING');

      if (!order.file_url) {
        throw new Error("No secure URL provided for this order's PDF.");
      }

      const tempFilePath = path.join(__dirname, `temp_print_${order.id}.pdf`);

      const response = await fetch(order.file_url);
      if (!response.ok)
        throw new Error(`HTTP error downloading file: ${response.statusText}`);

      const buffer = await response.buffer();
      fs.writeFileSync(tempFilePath, buffer);

      console.log(`    File downloaded successfully to: ${tempFilePath}`);

      // 2. Sent to Spooler
      socket.emit('job_status_update', {
        orderId: order.id,
        status: 'SENT_TO_SPOOLER',
      });
      console.log(
        '    Status -> SENT_TO_SPOOLER (Sending to Windows Default Printer)',
      );

      // Send to actual Windows printer queue targeting the selected printer
      const options = payload.printerName
        ? { printer: payload.printerName }
        : {};
      if (order.print_color_mode === 'BLACK_AND_WHITE') {
        options.monochrome = true;
      }

      await ptp.print(tempFilePath, options);
      console.log(
        `    Physical print job dispatched to hardware (${payload.printerName || 'Default Printer'}). Color Mode: ${order.print_color_mode}`,
      );

      // 3. Complete
      socket.emit('job_status_update', {
        orderId: order.id,
        status: 'COMPLETED',
      });
      console.log('    Status -> COMPLETED\n');

      // Cleanup temp file
      fs.unlinkSync(tempFilePath);
    } catch (error) {
      console.error(`!!! FAILED processing order ${order.id}:`, error.message);
      socket.emit('job_status_update', { orderId: order.id, status: 'FAILED' });
    }
  }

  console.log('=======================================');
  console.log('[BATCH COMPLETE] Awaiting next print queue...\n');
});
