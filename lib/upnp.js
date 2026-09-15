'use strict';

// ─── Router port forwarding (UPnP-IGD, NAT-PMP or PCP) for self-hosting ───
// With UPNP=true the server asks the router to forward its own port and, when the built-in TURN
// relay is on, the relay ports too, so people outside the network can reach a JS OS running at
// home. Uses the pure-JavaScript `port-mapper` package. Failures are reported, never fatal.

const { log } = require('./log');

const MAX_PORTS = 80;
const LIFETIME_SEC = 3600;   // renewed automatically by port-mapper while the server runs
const START_TIMEOUT_MS = 20000;

/** The ports a self-hosted JS OS needs reachable from outside. */
function portsFor(ice, httpPort) {
    const ports = [{ port: httpPort, protocol: 'tcp', label: 'web' }];
    if (ice.turnPort > 0) {
        ports.push({ port: ice.turnPort, protocol: 'udp', label: 'turn' }, { port: ice.turnPort, protocol: 'tcp', label: 'turn' });
        const [low, high] = ice.turnRelayPorts;
        for (let port = low; port <= high; port++) ports.push({ port, protocol: 'udp', label: 'relay' });
    }
    return ports;
}

/**
 * Forwards every port in `ports` on the router. `createMapper` is injectable for tests.
 * Resolves to { mapper, mapped, wanted, externalIp, failures }.
 */
async function mapPorts(ports, createMapper) {
    const result = { mapper: null, mapped: 0, wanted: ports.length, externalIp: null, failures: [] };
    if (ports.length > MAX_PORTS) {   // the web and TURN ports come first; the surplus relay ports are reported, not fatal
        for (const item of ports.slice(MAX_PORTS)) result.failures.push({ port: item.port, protocol: item.protocol, error: `not attempted: more than ${MAX_PORTS} ports (narrow TURN_RELAY_PORTS)` });
        ports = ports.slice(0, MAX_PORTS);
    }
    if (!createMapper) createMapper = (await import('port-mapper')).createMapper;
    const mapper = createMapper({ family: 'ipv4', description: 'JS OS', cleanupOnExit: true });
    result.mapper = mapper;
    if (typeof mapper.on === 'function') mapper.on('error', (err) => log('CALL', 'UPnP: ' + err.message));
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('the router did not answer')), START_TIMEOUT_MS);
            mapper.start((err) => { clearTimeout(timer); if (err) reject(err); else resolve(); });
        });
    } catch (err) {
        await close(mapper);   // release its sockets; the caller only sees the error
        throw err;
    }

    for (const item of ports) {
        try {
            const mapping = await new Promise((resolve, reject) => {
                mapper.map({ internalPort: item.port, externalPort: item.port, protocol: item.protocol, exact: true, lifetime: LIFETIME_SEC, description: 'JS OS ' + item.label },
                    (err, m) => (err ? reject(err) : resolve(m)));
            });
            result.mapped += 1;
            if (!result.externalIp && mapping && mapping.externalIp) result.externalIp = mapping.externalIp;
        } catch (err) {
            result.failures.push({ port: item.port, protocol: item.protocol, error: err.message });
            if (result.mapped === 0 && result.failures.length >= 2) break;   // the router is not cooperating; stop asking
        }
    }
    return result;
}

function close(mapper) {
    return new Promise((resolve) => {
        if (!mapper) return resolve();
        try { mapper.close(() => resolve()); } catch { resolve(); }
        setTimeout(resolve, 3000).unref();
    });
}

module.exports = { portsFor, mapPorts, close };
