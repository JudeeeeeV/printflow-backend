import { Injectable, CanActivate, ExecutionContext, BadRequestException, Logger } from '@nestjs/common';
import { Socket } from 'socket.io';

@Injectable()
export class PayloadSanitizationGuard implements CanActivate {
  private readonly logger = new Logger(PayloadSanitizationGuard.name);
  private readonly allowedExtensions = ['.pdf', '.png'];

  canActivate(context: ExecutionContext): boolean {
    const data = context.switchToWs().getData();
    // Assuming the data payload has an array of asset URLs or similar
    
    if (!data || !data.orders || !Array.isArray(data.orders)) {
      throw new BadRequestException('Invalid payload format');
    }

    for (const order of data.orders) {
      if (!order.file_url) {
        throw new BadRequestException(`Missing file_url for order ${order.id}`);
      }

      const urlLower = order.file_url.toLowerCase();
      const isValid = this.allowedExtensions.some(ext => urlLower.includes(ext));

      if (!isValid) {
        this.logger.warn(`Malicious payload detected: invalid file type for order ${order.id}: ${order.file_url}`);
        // In a real app we might write to THREAT_LOGS table here
        throw new BadRequestException('Payload blocked by sanitization guard: non-whitelisted file type detected.');
      }
    }

    return true;
  }
}
