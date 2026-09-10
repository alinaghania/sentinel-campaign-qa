"use client";

// Previews :
// - Gmail : react-letter (module communautaire qui reproduit les règles de
//   rendu/sanitization de Gmail — le plus proche du vrai sans les serveurs Google)
// - Outlook : transformation des propriétés ignorées par le moteur Word
//   (aucun module n'existe pour émuler Word — seuls Litmus/EoA ont de vrais clients)
// Mode sombre : simulation d'inversion forcée.
import { useMemo } from "react";
import DOMPurify from "isomorphic-dompurify";
import { Letter } from "react-letter";

export type PreviewMode = "desktop" | "mobile" | "gmail" | "outlook";

function simulateOutlook(html: string): string {
  let out = html.replace(/<style[\s\S]*?<\/style>/gi, "");
  out = out.replace(/style="([^"]*)"/gi, (_m, style: string) => {
    const cleaned = style
      .split(";")
      .filter((decl) => {
        const p = decl.split(":")[0]?.trim().toLowerCase();
        if (!p) return false;
        if (
          [
            "border-radius",
            "box-shadow",
            "max-width",
            "min-width",
            "float",
            "position",
            "background-image",
            "text-shadow",
            "opacity",
          ].includes(p)
        ) {
          return false;
        }
        if (p === "display" && /flex|grid/i.test(decl)) return false;
        return true;
      })
      .join(";");
    return `style="${cleaned}"`;
  });
  return out;
}

const DARK_FILTER = "invert(0.92) hue-rotate(180deg)";

export default function EmailPreview({
  html,
  mode = "gmail",
  scheme = "light",
}: {
  html: string;
  mode?: PreviewMode;
  scheme?: "light" | "dark";
}) {
  const chrome =
    mode === "gmail"
      ? { bar: scheme === "dark" ? "#2d2e30" : "#f6f8fc", label: "Gmail (simulation)", dot: "#ea4335" }
      : mode === "outlook"
        ? { bar: scheme === "dark" ? "#2d2e30" : "#f3f2f1", label: "Outlook (simulation)", dot: "#0078d4" }
        : null;

  const outlookSrcDoc = useMemo(() => {
    if (mode !== "outlook") return "";
    const clean = DOMPurify.sanitize(simulateOutlook(html), {
      WHOLE_DOCUMENT: true,
      ADD_TAGS: ["center"],
      FORBID_TAGS: ["script", "iframe", "object", "embed"],
    });
    const darkCss =
      scheme === "dark"
        ? `<style>html{filter:${DARK_FILTER};background:#111!important}img,video{filter:${DARK_FILTER}}</style>`
        : "";
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">${darkCss}</head><body style="margin:0;background:#ffffff;font-family:'Segoe UI',Calibri,Arial,sans-serif;">${clean}</body></html>`;
  }, [html, mode, scheme]);

  // Mobile : rendu dans un iframe à 375px → le viewport de l'iframe déclenche les
  // media queries responsive de l'email (vrai layout mobile), et rien n'est rogné
  // (scroll interne). Corrige le "les pixels disparaissent" du rendu clippé.
  const mobileSrcDoc = useMemo(() => {
    if (mode !== "mobile") return "";
    const clean = DOMPurify.sanitize(html, {
      WHOLE_DOCUMENT: true,
      ADD_TAGS: ["center"],
      FORBID_TAGS: ["script", "iframe", "object", "embed"],
    });
    const darkCss =
      scheme === "dark"
        ? `<style>html{filter:${DARK_FILTER};background:#111!important}img,video{filter:${DARK_FILTER}}</style>`
        : "";
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank">${darkCss}<style>html,body{margin:0;background:#fff}img{max-width:100%;height:auto}</style></head><body>${clean}</body></html>`;
  }, [html, mode, scheme]);

  return (
    <div
      className="mx-auto overflow-hidden rounded border border-bd bg-white"
      style={{ width: mode === "mobile" ? 375 : "100%", maxWidth: 720 }}
    >
      {chrome && (
        <div
          className="flex items-center gap-2 border-b px-3 py-2 text-[12px] font-semibold"
          style={{
            background: chrome.bar,
            color: scheme === "dark" ? "#e8eaed" : "#3c4043",
            borderColor: scheme === "dark" ? "#3c4043" : "#e0e0e0",
          }}
        >
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: chrome.dot }} />
          {chrome.label}
        </div>
      )}
      {mode === "outlook" || mode === "mobile" ? (
        <iframe
          title="Email preview"
          sandbox=""
          srcDoc={mode === "mobile" ? mobileSrcDoc : outlookSrcDoc}
          className="h-[68vh] w-full"
          style={{ background: "#fff" }}
        />
      ) : (
        <div
          className="h-[68vh] overflow-y-auto"
          style={{
            background: "#fff",
            filter: scheme === "dark" ? DARK_FILTER : undefined,
            fontFamily: mode === "gmail" ? "Roboto, Arial, sans-serif" : undefined,
          }}
        >
          <Letter html={html} rewriteExternalLinks={(url) => url} />
        </div>
      )}
      <div
        className="border-t px-3 py-1 text-[10px]"
        style={{
          background: scheme === "dark" ? "#2d2e30" : "#fafafa",
          color: scheme === "dark" ? "#9aa0a6" : "#9a9a9a",
          borderColor: scheme === "dark" ? "#3c4043" : "#e0e0e0",
        }}
      >
        Approximate rendering — not a certified Gmail/Outlook preview
      </div>
    </div>
  );
}
