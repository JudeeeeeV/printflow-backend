'use strict';

function projectReference(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return { local: true, reference: url.hostname };
    }
    if (!url.hostname.endsWith('.supabase.co')) {
      throw new Error(
        'Remote maintenance is limited to verified *.supabase.co project URLs',
      );
    }
    return { local: false, reference: url.hostname.split('.')[0] };
  } catch {
    throw new Error('SUPABASE_URL must be a valid absolute URL');
  }
}

function assertMaintenanceAccess(operation, options = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  const project = projectReference(url);
  if (!project.local) {
    if (process.env.ALLOW_PRODUCTION_MAINTENANCE !== 'true') {
      throw new Error(
        `${operation} refused a remote Supabase project. Set ALLOW_PRODUCTION_MAINTENANCE=true only for an approved maintenance window.`,
      );
    }
    if (process.env.CONFIRM_SUPABASE_PROJECT !== project.reference) {
      throw new Error(
        `${operation} requires CONFIRM_SUPABASE_PROJECT=${project.reference}`,
      );
    }
  }

  const dryRun = process.argv.includes('--dry-run');
  if (dryRun && options.write) {
    console.log(`[dry-run] ${operation} validated; no changes were made.`);
  }
  return { dryRun, projectReference: project.reference };
}

module.exports = { assertMaintenanceAccess };
