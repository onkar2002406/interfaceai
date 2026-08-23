/**
 * Boots one CoreBank instance per tenant, each on its own port.
 *
 * Three instances of the SAME vendor product, configured differently — the
 * stand-in for three institutions running the same core banking software.
 */

import { createCoreBankApp, TENANT_PORTS } from './server.js';
import { TENANTS } from './tenants.js';
import type { Server } from 'node:http';

export interface RunningInstance {
  tenantId: string;
  port: number;
  baseUrl: string;
  server: Server;
}

export async function startCoreBank(tenantIds: string[] = Object.keys(TENANTS)): Promise<RunningInstance[]> {
  const running: RunningInstance[] = [];
  for (const tenantId of tenantIds) {
    const port = TENANT_PORTS[tenantId];
    if (port === undefined) throw new Error(`No port assigned for tenant "${tenantId}"`);
    const { app } = createCoreBankApp(tenantId);
    const server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(port, () => resolve(s));
      s.on('error', reject);
    });
    running.push({ tenantId, port, baseUrl: `http://localhost:${port}`, server });
  }
  return running;
}

export async function stopCoreBank(instances: RunningInstance[]): Promise<void> {
  await Promise.all(
    instances.map((i) => new Promise<void>((resolve) => i.server.close(() => resolve()))),
  );
}

// Direct execution: `tsx apps/corebank/main.ts`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!)) {
  const only = process.argv[2] ? [process.argv[2]] : undefined;
  startCoreBank(only)
    .then((instances) => {
      for (const i of instances) {
        const t = TENANTS[i.tenantId]!;
        console.log(`  ${i.baseUrl}  ${t.institutionName} (CoreBank v${t.productVersion})`);
      }
      console.log('\nSign on with svc.demo / demo1234. Ctrl+C to stop.');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
