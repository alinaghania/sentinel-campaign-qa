import { NextRequest, NextResponse } from "next/server";
import { Inbox } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await Inbox.del(id);
  return NextResponse.json({ ok: true });
}
