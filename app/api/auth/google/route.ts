import { NextRequest, NextResponse } from "next/server";
import { gmailAuthUrl, gmailConfigured } from "@/lib/gmail";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  if (!gmailConfigured())
    return NextResponse.json(
      { error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET manquants dans .env.local" },
      { status: 400 }
    );
  return NextResponse.redirect(gmailAuthUrl(req.nextUrl.origin));
}
