const io = require('socket.io-client');

const SHOP_ID = process.argv[2] || 'test-shop-id';
const URL = 'http://localhost:3000/daemon';

console.log(`Starting mock daemon for shop: ${SHOP_ID}`);

const socket = io(URL, {
  query: { shopId: SHOP_ID, role: 'daemon' },
});

socket.on('connect', () => {
  console.log(`Daemon Connected with socket ID: ${socket.id}`);
});

socket.on('disconnect', () => {
  console.log('Daemon Disconnected');
});

socket.on('batch_execute', (payload) => {
  console.log('Received batch_execute command with payload:', payload);

  const { orders } = payload;
  if (!orders || !Array.isArray(orders)) {
    console.error('Invalid payload format');
    return;
  }

  orders.forEach((order, index) => {
    const delay = (index + 1) * 2000; // stagger the updates

    // Simulate downloading
    setTimeout(() => {
      console.log(`Simulating DOWNLOAD for order ${order.id}`);
      socket.emit('job_status_update', {
        orderId: order.id,
        shopId: SHOP_ID,
        status: 'DOWNLOADING',
      });
    }, delay);

    // Simulate sending to spooler
    setTimeout(() => {
      console.log(`Simulating SPOOLER for order ${order.id}. Color Mode: ${order.print_color_mode}`);
      socket.emit('job_status_update', {
        orderId: order.id,
        shopId: SHOP_ID,
        status: 'SENT_TO_SPOOLER',
      });
    }, delay + 2000);

    // Simulate completion
    setTimeout(() => {
      console.log(`Simulating COMPLETED for order ${order.id}`);
      socket.emit('job_status_update', {
        orderId: order.id,
        shopId: SHOP_ID,
        status: 'COMPLETED',
      });
    }, delay + 4000);
  });
});
