// POST : basculer le statut favori d'un mail reçu.
import { NextRequest, NextResponse } from "next/server";
import { Inbox } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const email = await Inbox.get(id);
  if (!email) return NextResponse.json({ error: "mail introuvable" }, { status: 404 });

  email.favorite = !email.favorite;
  await Inbox.put(email);
  return NextResponse.json(email);
}
