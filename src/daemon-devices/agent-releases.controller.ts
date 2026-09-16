import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseAuthGuard } from '../iam/guards/supabase-auth.guard';
import { RolesGuard } from '../iam/guards/roles.guard';
import { Roles } from '../iam/decorators/roles.decorator';
import { SupabaseService } from '../supabase/supabase.service';

@Controller('agent-releases')
export class AgentReleasesController {
  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {}

  @Get('latest')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles('CLERK', 'MANAGER')
  async latestWindowsRelease() {
    let downloadUrl =
      this.config.get<string>('AGENT_WINDOWS_DOWNLOAD_URL') || null;
    const storagePath = this.config.get<string>('AGENT_WINDOWS_STORAGE_PATH');
    if (!downloadUrl && storagePath) {
      downloadUrl = await this.supabase.createSignedStorageUrl(
        'agent-releases',
        storagePath,
        900,
      );
    }
    const version = this.config.get<string>('AGENT_WINDOWS_VERSION') || '0.1.0';
    return {
      available: Boolean(downloadUrl),
      platform: 'windows',
      version,
      fileName: `PrintFlowAgent-${version}-Setup.exe`,
      downloadUrl,
      sha256: this.config.get<string>('AGENT_WINDOWS_SHA256') || null,
      publishedAt:
        this.config.get<string>('AGENT_WINDOWS_PUBLISHED_AT') || null,
    };
  }
}
