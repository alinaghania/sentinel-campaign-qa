import { NextRequest, NextResponse } from "next/server";
import { gmailHandleCallback } from "@/lib/gmail";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code)
    return NextResponse.redirect(new URL("/inbox?error=code_manquant", req.url));
  try {
    await gmailHandleCallback(code, req.nextUrl.origin);
    return NextResponse.redirect(new URL("/inbox?connected=gmail", req.url));
  } catch (e) {
    const msg = encodeURIComponent(e instanceof Error ? e.message : "erreur");
    return NextResponse.redirect(new URL(`/inbox?error=${msg}`, req.url));
  }
}
