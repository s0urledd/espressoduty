// Server-Sent Events: the polling engine publishes a snapshot after every
// poll tick and each connected dashboard applies it immediately — no page
// refresh interval.

import { snapshot, subscribe, type Snapshot } from '@/lib/state';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (snap: Snapshot) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(snap)}\n\n`));
        } catch {
          unsubscribe();
          if (heartbeat) clearInterval(heartbeat);
        }
      };
      send(snapshot());
      unsubscribe = subscribe(send);
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch {
          unsubscribe();
          if (heartbeat) clearInterval(heartbeat);
        }
      }, 25_000);
    },
    cancel() {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
