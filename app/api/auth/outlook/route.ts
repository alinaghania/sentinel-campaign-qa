import { NextRequest, NextResponse } from "next/server";
import { outlookAuthUrl, outlookConfigured, pkcePair } from "@/lib/outlook";
import crypto from "crypto";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  if (!outlookConfigured())
    return NextResponse.json(
      { error: "MS_CLIENT_ID / MS_CLIENT_SECRET manquants dans .env.local" },
      { status: 400 }
    );
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(16).toString("hex");
  const res = NextResponse.redirect(outlookAuthUrl(req.nextUrl.origin, challenge, state));
  res.cookies.set("ms_pkce", verifier, { httpOnly: true, maxAge: 600, path: "/" });
  res.cookies.set("ms_state", state, { httpOnly: true, maxAge: 600, path: "/" });
  return res;
}
