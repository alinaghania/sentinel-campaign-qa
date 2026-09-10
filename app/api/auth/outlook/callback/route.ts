import { NextRequest, NextResponse } from "next/server";
import { outlookHandleCallback } from "@/lib/outlook";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const verifier = req.cookies.get("ms_pkce")?.value;
  const expectedState = req.cookies.get("ms_state")?.value;
  if (!code || !verifier)
    return NextResponse.redirect(new URL("/inbox?error=code_ou_pkce_manquant", req.url));
  if (!state || state !== expectedState)
    return NextResponse.redirect(new URL("/inbox?error=state_invalide", req.url));
  try {
    await outlookHandleCallback(code, verifier, req.nextUrl.origin);
    return NextResponse.redirect(new URL("/inbox?connected=outlook", req.url));
  } catch (e) {
    const msg = encodeURIComponent(e instanceof Error ? e.message : "erreur");
    return NextResponse.redirect(new URL(`/inbox?error=${msg}`, req.url));
  }
}
