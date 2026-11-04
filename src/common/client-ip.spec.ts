import { clientIp } from './client-ip';

describe('clientIp', () => {
  it('takes the caller, the leftmost X-Forwarded-For entry, behind the edge', () => {
    expect(
      clientIp({
        headers: { 'x-forwarded-for': '5.155.12.34, 185.152.66.10' },
        ip: '100.64.0.7',
      }),
    ).toBe('5.155.12.34');
  });

  it('accepts IPv6 and a header given as an array', () => {
    expect(
      clientIp({ headers: { 'x-forwarded-for': ['2a02:6ea0::1, 10.0.0.1'] } }),
    ).toBe('2a02:6ea0::1');
  });

  it('falls back to the socket address when the header is missing or unusable', () => {
    expect(clientIp({ headers: {}, ip: '100.64.0.7' })).toBe('100.64.0.7');
    expect(
      clientIp({
        headers: { 'x-forwarded-for': 'not-an-ip' },
        ip: '100.64.0.7',
      }),
    ).toBe('100.64.0.7');
    expect(clientIp({ socket: { remoteAddress: '127.0.0.1' } })).toBe(
      '127.0.0.1',
    );
    expect(clientIp({})).toBe('unknown');
  });
});
