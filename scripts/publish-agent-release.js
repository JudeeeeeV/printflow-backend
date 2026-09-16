const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const backendRoot = path.resolve(__dirname, '..');
const envPath = path.join(backendRoot, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line
      .slice(0, separator)
      .trim()
      .replace(/^\uFEFF/, '');
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  const releaseDirectory = path.join(backendRoot, 'agent', 'release');
  const metadataPath = path.join(releaseDirectory, 'release.json');
  if (!fs.existsSync(metadataPath)) {
    throw new Error('Build the Windows agent before publishing it');
  }
  const metadata = JSON.parse(
    fs.readFileSync(metadataPath, 'utf8').replace(/^\uFEFF/, ''),
  );
  const installerPath = path.resolve(releaseDirectory, metadata.fileName);
  if (
    !installerPath.startsWith(`${path.resolve(releaseDirectory)}${path.sep}`)
  ) {
    throw new Error('Release metadata references an invalid installer path');
  }
  const installer = fs.readFileSync(installerPath);
  const sha256 = createHash('sha256').update(installer).digest('hex');
  if (sha256 !== metadata.sha256) {
    throw new Error('Installer checksum does not match release metadata');
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: buckets, error: bucketError } =
    await client.storage.listBuckets();
  if (bucketError) throw bucketError;
  if (!buckets.some((bucket) => bucket.name === 'agent-releases')) {
    const { error } = await client.storage.createBucket('agent-releases', {
      public: false,
      fileSizeLimit: 50 * 1024 * 1024,
      allowedMimeTypes: ['application/vnd.microsoft.portable-executable'],
    });
    if (error) throw error;
  }

  const storagePath = `windows/${metadata.fileName}`;
  process.stdout.write('Uploading installer...\n');
  const { error: uploadError } = await client.storage
    .from('agent-releases')
    .upload(storagePath, installer, {
      contentType: 'application/vnd.microsoft.portable-executable',
      cacheControl: '3600',
      upsert: true,
    });
  if (uploadError) throw uploadError;

  process.stdout.write(
    [
      'Windows agent release uploaded successfully.',
      `AGENT_WINDOWS_STORAGE_PATH=${storagePath}`,
      `AGENT_WINDOWS_VERSION=${metadata.version}`,
      `AGENT_WINDOWS_SHA256=${metadata.sha256}`,
      `AGENT_WINDOWS_PUBLISHED_AT=${metadata.builtAt}`,
    ].join('\n') + '\n',
  );
}

main().catch((error) => {
  console.error(`Agent release upload failed: ${error.message}`);
  process.exitCode = 1;
});
