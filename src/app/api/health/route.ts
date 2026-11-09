import { NextResponse } from 'next/server';
import { shallowHealth } from '@/modules/platform/infrastructure/health';

export const dynamic = 'force-dynamic';

/** Salud superficial publica: no revela informacion interna ni de version (Q4 A). */
export function GET() {
  return NextResponse.json(shallowHealth(), { headers: { 'Cache-Control': 'no-store' } });
}
