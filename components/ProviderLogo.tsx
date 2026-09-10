// Logos officiels Gmail (enveloppe 4 couleurs) et Outlook (tuile bleue) en SVG inline.
export function GmailLogo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 40) / 52} viewBox="0 0 52 40" aria-label="Gmail">
      <path fill="#4285F4" d="M3.6 40h6.8V19.7L0 11.9v24.5C0 38.4 1.6 40 3.6 40z" />
      <path fill="#34A853" d="M41.6 40h6.8c2 0 3.6-1.6 3.6-3.6V11.9l-10.4 7.8z" />
      <path fill="#FBBC04" d="M41.6 5.2v14.5L52 11.9V7c0-4.5-5.2-7.1-8.8-4.4z" />
      <path fill="#EA4335" d="M10.4 19.7V5.2L26 16.9 41.6 5.2v14.5L26 31.4z" />
      <path fill="#C5221F" d="M0 7v4.9l10.4 7.8V5.2L8.8 2.6C5.2-.1 0 2.5 0 7z" />
    </svg>
  );
}

export function OutlookLogo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-label="Outlook">
      <rect x="9" y="4" width="21" height="24" rx="2" fill="#1490DF" />
      <rect x="9" y="4" width="21" height="12" rx="2" fill="#28A8EA" />
      <path d="M9 16h21v10a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2z" fill="#0078D4" />
      <path d="M9 10l10.5 6L30 10v2l-10.5 6L9 12z" fill="#0364B8" opacity=".55" />
      <rect x="2" y="8" width="16" height="16" rx="2" fill="#0F6CBD" />
      <path
        d="M10 11.2c-2.5 0-4.2 2-4.2 4.8s1.7 4.8 4.2 4.8 4.2-2 4.2-4.8-1.7-4.8-4.2-4.8zm0 7.6c-1.3 0-2.1-1.2-2.1-2.8s.8-2.8 2.1-2.8 2.1 1.2 2.1 2.8-.8 2.8-2.1 2.8z"
        fill="#fff"
      />
    </svg>
  );
}

export default function ProviderLogo({
  provider,
  size = 22,
}: {
  provider: "gmail" | "outlook";
  size?: number;
}) {
  return provider === "gmail" ? <GmailLogo size={size} /> : <OutlookLogo size={size} />;
}
