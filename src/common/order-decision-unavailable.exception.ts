import { ServiceUnavailableException } from '@nestjs/common';

// Fixed public text only; never accept database or network details here.
export class OrderDecisionUnavailableException extends ServiceUnavailableException {
  constructor() {
    super(
      'The order service could not confirm this decision. Refresh the order status before trying again.',
    );
  }
}
