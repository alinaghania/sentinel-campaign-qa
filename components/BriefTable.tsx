"use client";

// Faithful, document-styled rendering of the brief grid (same rows/columns as the Excel):
// rows = content blocks (Subject line, Preheader, COPY 1, CTA 1…), columns = languages.
// Pure presentation component — no fetch, no mutation. The extraction is rendered as-is,
// no LLM challenge/warnings.
import { useState } from "react";
import type { BriefGrid, BriefMockup } from "@/lib/types";

export default function BriefTable({
  grid,
  mockups,
  header = true,
}: {
  grid: BriefGrid;
  mockups?: BriefMockup[];
  /** Kept for backwards compatibility with existing callers — no longer displayed. */
  warnings?: string[];
  /** Sober document header ("Brief" + counts). Hidden when embedded under an existing header. */
  header?: boolean;
}) {
  const [zoomed, setZoomed] = useState<BriefMockup | null>(null);

  const hasGrid = grid.languages.length > 0 && grid.blocks.length > 0;

  return (
    <div className="space-y-7">
      {/* --- Document header: sober, editorial --- */}
      {header && (
        <div className="border-b border-bd pb-3">
          <div className="doc-title text-[26px] leading-tight">Brief</div>
          <div className="mt-1 text-[9.5px] font-bold uppercase tracking-[0.2em] text-dim">
            {hasGrid
              ? `${grid.languages.length} ${grid.languages.length > 1 ? "languages" : "language"} · ${grid.blocks.length} ${grid.blocks.length > 1 ? "blocks" : "block"}`
              : "No grid content"}
            {mockups && mockups.length > 0 &&
              ` · ${mockups.length} ${mockups.length > 1 ? "mockups" : "mockup"}`}
          </div>
        </div>
      )}

      {/* --- Content grid: blocks x languages, faithful to the Excel --- */}
      <div>
        <h3 className="doc-section">Content</h3>
        {hasGrid ? (
          <div className="mt-2.5 max-h-[70vh] overflow-x-auto overflow-y-auto border-y border-bd">
            <table className="w-full border-collapse text-[12.5px] leading-snug">
              <thead>
                <tr>
                  <th className="sticky left-0 top-0 z-20 min-w-[140px] border-b border-bd bg-bg px-2.5 py-2 text-left text-[9.5px] font-bold uppercase tracking-[0.16em] text-dim">
                    Block
                  </th>
                  {grid.languages.map((lang) => (
                    <th
                      key={lang}
                      className="sticky top-0 z-10 min-w-[220px] border-b border-l border-bd bg-bg px-2.5 py-2 text-left text-[9.5px] font-bold uppercase tracking-[0.16em] text-dim"
                    >
                      {/* Libellé ORIGINAL du fichier (ex "MX"), pas le code interne (ES) */}
                      {grid.langLabels?.[lang] ?? lang}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.blocks.map((block) => (
                  <tr key={block.name} className="border-b border-bd/50 align-top last:border-b-0">
                    <td className="sticky left-0 z-10 bg-bg px-2.5 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-dim">
                      {block.name}
                    </td>
                    {grid.languages.map((lang) => {
                      const value = block.valueByLang[lang];
                      return (
                        <td
                          key={lang}
                          className="whitespace-pre-wrap border-l border-bd/50 px-2.5 py-2"
                        >
                          {value && value.trim() !== "" ? (
                            value
                          ) : (
                            <span className="text-dim/50">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-2 text-[11px] italic text-dim">
            No grid content extracted from the brief.
          </p>
        )}
      </div>

      {/* --- Expected links per block / market --- */}
      {grid.expectedLinks.length > 0 && (
        <div className="border-t border-bd pt-5">
          <h3 className="doc-section">Expected links</h3>
          <div className="mt-2.5 space-y-2.5">
            {grid.expectedLinks.map((link, i) => {
              // Faithful fallback: linksByMarket first, else the WW/CN shortcuts.
              const entries: Array<[string, string]> = link.linksByMarket
                ? Object.entries(link.linksByMarket)
                : (
                    [
                      ["WW", link.ww],
                      ["CN", link.cn],
                    ] as Array<[string, string | undefined]>
                  ).filter((e): e is [string, string] => Boolean(e[1]));
              return (
                <div key={`${link.block}-${i}`} className="border-b border-bd/50 pb-2 last:border-b-0">
                  <div className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-dim">
                    {link.block}
                    {link.ctaLabelByLang && Object.keys(link.ctaLabelByLang).length > 0 && (
                      <span className="ml-1.5 normal-case tracking-normal text-dim/70">
                        {Object.entries(link.ctaLabelByLang)
                          .map(([lang, label]) => `${lang}: ${label}`)
                          .join(" · ")}
                      </span>
                    )}
                  </div>
                  {entries.length > 0 ? (
                    <ul className="mt-0.5 space-y-0.5">
                      {entries.map(([market, url]) => (
                        <li key={market} className="flex gap-2 font-mono text-[11.5px]">
                          <span className="shrink-0 font-bold uppercase text-dim">{market}:</span>
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="break-all text-accent underline underline-offset-2 hover:text-fg"
                          >
                            {url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-0.5 text-[11px] italic text-dim">No link provided.</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* --- Mockups: clickable thumbnails with a simple zoom overlay --- */}
      {mockups && mockups.length > 0 && (
        <div className="border-t border-bd pt-5">
          <h3 className="doc-section">Mockup</h3>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {mockups.map((m, i) => (
              <button
                key={`${m.name}-${i}`}
                type="button"
                onClick={() => setZoomed(m)}
                className="cursor-zoom-in border border-bd hover:border-fg"
                title={m.name}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={m.dataUrl}
                  alt={m.name}
                  className="h-28 w-auto object-contain"
                />
              </button>
            ))}
          </div>
          {zoomed && (
            <div
              className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-6"
              onClick={() => setZoomed(null)}
              role="button"
              aria-label="Close mockup preview"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={zoomed.dataUrl}
                alt={zoomed.name}
                className="max-h-full max-w-full border border-bd bg-white object-contain"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
