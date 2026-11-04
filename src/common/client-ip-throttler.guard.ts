import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { IpSource, clientIp } from './client-ip';

/**
 * The global rate limit, counted per caller instead of per Railway proxy.
 * Ref: https://docs.nestjs.com/security/rate-limiting#proxies
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, any>): Promise<string> {
    return Promise.resolve(clientIp(req as IpSource));
  }
}
