import { SetMetadata } from '@nestjs/common';

export const ADMIN_TOKEN_TYPE_KEY = 'adminTokenType';
export type AdminTokenType = 'admin-temp' | 'admin-access';

export const RequireAdminToken = (tokenType: AdminTokenType) =>
  SetMetadata(ADMIN_TOKEN_TYPE_KEY, tokenType);
