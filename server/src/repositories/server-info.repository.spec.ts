import { NetworkInterfaceInfo, networkInterfaces } from 'node:os';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ServerInfoRepository } from 'src/repositories/server-info.repository.js';

vi.mock('node:os', () => ({ networkInterfaces: vi.fn() }));

describe('LAN interface addresses', () => {
  it('returns private IPv4 and IPv6 ULA addresses, excluding loopback, public, and link-local addresses', () => {
    const addresses: Pick<NetworkInterfaceInfo, 'address' | 'family' | 'internal'>[] = [
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: '192.168.1.2', family: 'IPv4', internal: false },
      { address: '10.0.0.2', family: 'IPv4', internal: false },
      { address: '172.16.0.2', family: 'IPv4', internal: false },
      { address: '172.31.255.2', family: 'IPv4', internal: false },
      { address: '172.32.0.2', family: 'IPv4', internal: false },
      { address: '8.8.8.8', family: 'IPv4', internal: false },
      { address: '169.254.1.2', family: 'IPv4', internal: false },
      { address: 'fd00::1', family: 'IPv6', internal: false },
      { address: 'fc00::2', family: 'IPv6', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '2001:db8::1', family: 'IPv6', internal: false },
    ];
    vi.mocked(networkInterfaces).mockReturnValue({
      eth0: addresses.map((entry) => ({ ...entry, cidr: null, mac: '00:00:00:00:00:00', netmask: '', scopeid: 0 })),
    });
    const repository = new ServerInfoRepository(new ConfigRepository(), LoggingRepository.create());
    expect(repository.getLocalAddresses()).toEqual([
      '192.168.1.2',
      '10.0.0.2',
      '172.16.0.2',
      '172.31.255.2',
      '[fd00::1]',
      '[fc00::2]',
    ]);
  });
});
