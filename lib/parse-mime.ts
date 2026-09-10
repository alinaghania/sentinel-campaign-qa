// Parsing MIME commun aux 3 canaux (Gmail raw, Outlook $value, upload .eml).
// Extrait HTML + headers QA (Authentication-Results, List-Unsubscribe).

import { simpleParser, type ParsedMail } from "mailparser";
import type { HeaderChecks } from "./types";

export interface ParsedEmail {
  subject: string;
  from: string;
  receivedAt: string;
  html: string;
  headerChecks: HeaderChecks;
  rawMime: string;
}

function extractAuthResults(raw: string | undefined): Pick<HeaderChecks, "spf" | "dkim" | "dmarc"> {
  if (!raw) return {};
  const pick = (k: string) => {
    const m = new RegExp(`${k}=([a-z]+)[^;]*`, "i").exec(raw);
    return m ? m[0].trim().slice(0, 120) : undefined;
  };
  return { spf: pick("spf"), dkim: pick("dkim"), dmarc: pick("dmarc") };
}

export async function parseMime(rawMime: string | Buffer): Promise<ParsedEmail> {
  const parsed: ParsedMail = await simpleParser(rawMime);
  const authRaw = parsed.headers.get("authentication-results")?.toString();
  const headerChecks: HeaderChecks = {
    ...extractAuthResults(authRaw),
    // 1000 : un AR Gmail réel avec 2 signatures DKIM fait ~450 chars ; 500
    // tronquait la clause dmarc dès la 3e signature.
    authResultsRaw: authRaw?.slice(0, 1000),
    listUnsubscribe: parsed.headers.get("list-unsubscribe")?.toString()?.slice(0, 300),
    listUnsubscribePost: parsed.headers.get("list-unsubscribe-post")?.toString()?.slice(0, 100),
    from: parsed.from?.text,
  };

  // Remapper les images inline CID en data-URIs pour l'aperçu
  let html = parsed.html || (parsed.textAsHtml ?? "");
  for (const att of parsed.attachments ?? []) {
    if (att.cid && att.content) {
      const dataUri = `data:${att.contentType};base64,${att.content.toString("base64")}`;
      html = html.split(`cid:${att.cid}`).join(dataUri);
    }
  }

  return {
    subject: parsed.subject ?? "(sans objet)",
    from: parsed.from?.text ?? "?",
    receivedAt: (parsed.date ?? new Date()).toISOString(),
    html,
    headerChecks,
    rawMime: typeof rawMime === "string" ? rawMime : rawMime.toString("utf-8"),
  };
}
