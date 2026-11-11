/** Loaded by the SDK's Node child before any CLI code. No endpoint or secret is embedded. */
export const NATIVE_AGENT_NETWORK_GUARD = String.raw`
'use strict';
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const port = Number(process.env.NATIVE_AGENT_BRIDGE_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('NATIVE_AGENT_NETWORK_GUARD_INVALID');
function deny() {
  if (process.env.NATIVE_AGENT_NETWORK_DENIAL_FILE) fs.appendFileSync(process.env.NATIVE_AGENT_NETWORK_DENIAL_FILE, 'denied\n');
  throw new Error('NATIVE_AGENT_EXTERNAL_NETWORK_DENIED');
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === 'object' ? first : { port: first, host: args[1] };
  if (options.path || String(options.host || options.hostname || '') !== '127.0.0.1' || Number(options.port) !== port) return deny();
  return connect.apply(this, args);
};
tls.connect = deny;
dns.lookup = deny;
dns.resolve = deny;
dns.resolve4 = deny;
dns.resolve6 = deny;
dns.promises.lookup = async () => deny();
dns.promises.resolve = async () => deny();
syncBuiltinESMExports();
`;
