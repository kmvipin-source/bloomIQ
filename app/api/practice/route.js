import { NextResponse } from "next/server";
export async function GET() { return NextResponse.json({ deprecated: true }, { status: 410 }); }
export async function POST() { return NextResponse.json({ deprecated: true }, { status: 410 }); }

