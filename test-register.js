fetch('http://localhost:3000/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'noehboiser221@gmail.com', password: 'Password123!', accountType: 'Student' })
}).then(res => res.json()).then(console.log).catch(console.error);
