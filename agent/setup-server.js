const http = require('node:http');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const credentialStore = require('./credential-store');

const MAX_REQUEST_BYTES = 16 * 1024;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setupHtml(token, backendUrl) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>PrintFlow Printer Agent Setup</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#f4f4f4;color:#161616;font-family:Arial,sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:100%;max-width:460px;background:#fff;border-top:6px solid #0f62fe;box-shadow:0 16px 40px #0002;padding:30px}h1{font-size:25px;margin:0 0 8px}p{color:#525252;line-height:1.5}.server{font-size:12px;background:#f4f4f4;padding:10px;word-break:break-all}label{display:block;font-size:13px;font-weight:700;margin:18px 0 6px}input{width:100%;padding:12px;border:1px solid #8d8d8d;font-size:15px}button{width:100%;margin-top:24px;padding:13px;border:0;background:#0f62fe;color:#fff;font-weight:700;font-size:15px;cursor:pointer}button:disabled{background:#8d8d8d;cursor:wait}.status{margin-top:16px;font-size:14px}.error{color:#da1e28}.success{color:#198038}
  </style>
</head>
<body><main class="card">
  <h1>Connect Printer Agent</h1>
  <p>Sign in once with a verified print-shop account. Your password is used only for this registration and is not stored.</p>
  <div class="server">Server: ${escapeHtml(backendUrl)}</div>
  <form id="form">
    <label for="email">Shop email</label><input id="email" type="email" autocomplete="username" required>
    <label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required>
    <label for="name">Computer name</label><input id="name" value="${escapeHtml(os.hostname())}" maxlength="120" required>
    <button id="submit" type="submit">Connect Printer Agent</button>
    <div id="status" class="status" aria-live="polite"></div>
  </form>
  <script>
    const form=document.getElementById('form'),button=document.getElementById('submit'),status=document.getElementById('status');
    form.addEventListener('submit',async(e)=>{e.preventDefault();button.disabled=true;status.className='status';status.textContent='Registering this computer...';
      try{const response=await fetch('/register?token=${token}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email.value,password:password.value,deviceName:name.value})});const data=await response.json();if(!response.ok)throw new Error(data.message||'Registration failed');password.value='';status.className='status success';status.textContent='Connected successfully. You can close this window.';button.textContent='Connected';}
      catch(error){status.className='status error';status.textContent=error.message;button.disabled=false;}}
    );
  </script>
</main></body></html>`;
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', url], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }
  throw new Error('Automatic setup is currently supported only on Windows.');
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
        reject(new Error('Setup request is too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid setup request'));
      }
    });
    request.on('error', reject);
  });
}

function runSetup(apiClient, backendUrl) {
  return new Promise((resolve, reject) => {
    const token = randomBytes(32).toString('base64url');
    let completed = false;
    const server = http.createServer(async (request, response) => {
      const requestUrl = new URL(request.url, 'http://127.0.0.1');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (
        request.method === 'GET' &&
        requestUrl.pathname === '/' &&
        requestUrl.searchParams.get('token') === token
      ) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(setupHtml(token, backendUrl));
        return;
      }
      if (
        request.method === 'POST' &&
        requestUrl.pathname === '/register' &&
        requestUrl.searchParams.get('token') === token &&
        !completed
      ) {
        try {
          const body = await readJson(request);
          if (!body.email || !body.password || !body.deviceName) {
            throw new Error('Email, password, and computer name are required');
          }
          const login = await apiClient.login(
            String(body.email).trim(),
            String(body.password),
          );
          if (login.user?.roleTag !== 'Print Shop' || !login.token) {
            throw new Error('A verified print-shop account is required');
          }
          const registration = await apiClient.registerDevice(
            login.token,
            String(body.deviceName).trim(),
          );
          await credentialStore.save({
            deviceId: registration.deviceId,
            deviceSecret: registration.deviceSecret,
            shopId: registration.shopId,
          });
          completed = true;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ success: true }));
          setTimeout(() => server.close(() => resolve()), 750);
        } catch (error) {
          response.writeHead(error.status === 401 ? 401 : 400, {
            'Content-Type': 'application/json',
          });
          response.end(
            JSON.stringify({ message: error.message || 'Registration failed' }),
          );
        }
        return;
      }
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not found');
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const url = `http://127.0.0.1:${address.port}/?token=${token}`;
      try {
        openBrowser(url);
      } catch (error) {
        server.close();
        reject(error);
      }
    });
    setTimeout(
      () => {
        if (!completed) {
          server.close();
          reject(
            new Error(
              'Printer-agent setup expired. Start the agent again to retry.',
            ),
          );
        }
      },
      10 * 60 * 1000,
    ).unref();
  });
}

module.exports = { runSetup };
