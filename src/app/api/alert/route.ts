// Fires a test alert to every configured channel, used by the dashboard's
// "test alert" button: curl -X POST localhost:3030/api/alert

import { NextResponse } from 'next/server';
import { sendAlert } from '@/lib/alerts';
import { loadConfig, configuredChannels } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function POST() {
  const channels = configuredChannels(loadConfig());
  if (channels.length === 0) {
    return NextResponse.json({ ok: false, error: 'no alert channels configured' }, { status: 400 });
  }
  await sendAlert({
    severity: 'info',
    title: 'Test alert',
    lines: ['espressoduty can reach this channel'],
  });
  return NextResponse.json({ ok: true, channels });
}
