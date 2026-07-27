#!/usr/bin/env node
/**
 * mock-agent CLI.
 *
 *   npx mock-agent --port 8787 --token dev [--capabilities files,mcp-tools]
 *
 * Prints a ready line on stdout once listening. Callers should still poll
 * GET /app/v1/health rather than parsing this line or sleeping — see ADR-0005.
 */
import { createMockAgent } from './server.js';

interface Args {
  port: number;
  token: string;
  capabilities: string[];
  ownerId: string;
}

const usage = `Usage: mock-agent --token <token> [--port <port>] [--capabilities <csv>]

  --token <token>        Bearer token to accept. Required.
  --port <port>          Port to listen on. Default 8787. 0 picks a free port.
  --capabilities <csv>   Extra capabilities to declare, e.g. files,mcp-tools.
                         'chat' is always declared; it is mandatory and gates nothing.
  --owner-id <id>        Owner id every inbound personId is checked against
                         (contract invariant 4). Default 'owner-mock'. Configured
                         out of band, exactly like the token — the contract defines
                         no way to discover it over the wire.
`;

const parseArgs = (argv: readonly string[]): Args => {
  const args: Args = { port: 8787, token: '', capabilities: [], ownerId: 'owner-mock' };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--port':
        if (value === undefined) throw new Error('--port requires a value');
        args.port = Number(value);
        if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
          throw new Error(`--port must be an integer 0-65535, got ${value}`);
        }
        i += 1;
        break;
      case '--token':
        if (value === undefined) throw new Error('--token requires a value');
        args.token = value;
        i += 1;
        break;
      case '--capabilities':
        if (value === undefined) throw new Error('--capabilities requires a value');
        args.capabilities = value
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
        i += 1;
        break;
      case '--owner-id':
        if (value === undefined) throw new Error('--owner-id requires a value');
        args.ownerId = value;
        i += 1;
        break;
      case '--help':
      case '-h':
        console.log(usage);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }

  if (!args.token) throw new Error('--token is required');
  return args;
};

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`mock-agent: ${(err as Error).message}\n`);
  console.error(usage);
  process.exit(2);
}

const server = createMockAgent({
  token: args.token,
  capabilities: args.capabilities,
  ownerId: args.ownerId,
});

server.listen(args.port, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : args.port;
  const caps = ['chat', ...args.capabilities.filter((c) => c !== 'chat')].join(',');
  console.log(`mock-agent listening on http://127.0.0.1:${port} (capabilities: ${caps})`);
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
