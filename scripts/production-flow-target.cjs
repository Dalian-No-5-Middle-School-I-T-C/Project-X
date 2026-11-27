// The scanner runs inside Windows. Only explicitly configured private VM addresses are valid.
const assert = require('node:assert/strict');
const { BlockList, isIP } = require('node:net');

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8);
loopback.addAddress('::1', 'ipv6');
const privateNetwork = new BlockList();
privateNetwork.addSubnet('10.0.0.0', 8);
privateNetwork.addSubnet('172.16.0.0', 12);
privateNetwork.addSubnet('192.168.0.0', 16);
privateNetwork.addSubnet('fc00::', 7, 'ipv6');

function validateTargets({ server, scanner }) {
  for (const [kind, value] of Object.entries({ server, scanner })) {
    const url = new URL(value);
    assert(['https:', 'http:'].includes(url.protocol) && url.origin === value,
      `Configure flow ${kind} as an HTTP(S) origin without credentials or path`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const family = isIP(host) === 6 ? 'ipv6' : 'ipv4';
    const local = host === 'localhost' || (isIP(host) && loopback.check(host, family));
    assert(local || (kind === 'server' && isIP(host) && privateNetwork.check(host, family)),
      `Invalid isolated ${kind} address: ${url.origin}`);
  }
}
module.exports = { validateTargets };
