async function test() {
  try {
    console.log('Logging in...');
    const loginRes = await fetch('http://localhost:3000/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'jiezelmaelibres@gmail.com',
        password: 'printflow123'
      })
    });
    
    const loginData = await loginRes.json();
    console.log('Login Response Status:', loginRes.status);
    console.log('Login Response:', loginData);
    
    if (loginRes.status !== 201 && loginRes.status !== 200) return;

    const tempToken = loginData.temp_token;
    
    console.log('Trying to setup 2FA with a dummy code...');
    const setupRes = await fetch('http://localhost:3000/admin/auth/setup-2fa', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tempToken}` 
      },
      body: JSON.stringify({ token: '123456' })
    });
    
    const setupData = await setupRes.json();
    console.log('Setup Response Status:', setupRes.status);
    console.log('Setup Response Data:', setupData);
    
  } catch (err) {
    console.log('Error:', err);
  }
}

test();
