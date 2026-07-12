import { NextResponse } from 'next/server';
import { snapshot } from '@/lib/state';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(snapshot());
}
