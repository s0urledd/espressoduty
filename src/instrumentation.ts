// Next.js instrumentation hook: boots the polling engine in the same
// process that serves the dashboard. Runs once on server start.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { startMonitoring, stopMonitoring } = await import('./lib/monitor');
  startMonitoring();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void stopMonitoring(signal).finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
