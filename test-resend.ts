import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Resend } from 'resend';

async function test() {
  const resend = new Resend('re_imUm3yuR_Esz55vLVLo42Bo3PLHPWnfz9');
  const html = readFileSync(resolve(process.cwd(), 'supabase/templates/confirm-signup.html'), 'utf8');

  console.log("Sending email...");
  const result = await resend.emails.send({
    from: 'PrintFlow <onboarding@resend.dev>',
    to: 'noehboiser221@gmail.com',
    subject: 'Your PrintFlow verification code',
    html: html.replace(/\{\{\s*\.Token\s*\}\}/g, '12345678'),
    text: 'Test',
  });
  console.log(result);
}

test().catch(console.error);
