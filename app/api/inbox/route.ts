import { NextResponse } from "next/server";
import { Connections, Inbox } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const [emails, connections] = await Promise.all([Inbox.list(), Connections.list()]);
  // ne pas renvoyer les gros payloads dans la liste
  const light = emails.map(({ html, rawMime, ...rest }) => ({
    ...rest,
    hasHtml: Boolean(html),
    sizeKB: rawMime ? Math.round(rawMime.length / 1024) : undefined,
  }));
  return NextResponse.json({ emails: light, connections });
}
