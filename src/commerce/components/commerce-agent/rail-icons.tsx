import type {ReactNode} from "react";

type IconProps = {size?: number};

function RailIcon({size = 22, children}: IconProps & {children: ReactNode}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

export function RailHomeIcon(props: IconProps) {
  return <RailIcon {...props}>
    <path d="M3.5 10.5a2 2 0 0 1 .8-1.6l6.5-4.875a2 2 0 0 1 2.4 0L19.7 8.9a2 2 0 0 1 .8 1.6V18a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 18Z" fill="var(--rail-glyph-fill, none)" />
    <path d="M12 14v4" stroke="var(--rail-glyph-detail, currentColor)" />
  </RailIcon>;
}

export function RailAgentIcon(props: IconProps) {
  return <RailIcon {...props}>
    <path d="M7.5 4.5h9a4 4 0 0 1 4 4v5.25a4 4 0 0 1-4 4h-5.75L6 21v-3.55a4 4 0 0 1-2.5-3.7V8.5a4 4 0 0 1 4-4Z" fill="var(--rail-glyph-fill, none)" />
    <path d="m8 8.75 2.75 2.5L8 13.75m5.25 0h3" stroke="var(--rail-glyph-detail, currentColor)" />
  </RailIcon>;
}

export function RailVideoIcon(props: IconProps) {
  return <RailIcon {...props}>
    <path d="m16.5 10 4-3a.5.5 0 0 1 .8.4v9.2a.5.5 0 0 1-.8.4l-4-3" fill="var(--rail-glyph-fill, none)" />
    <rect x="2.5" y="5.5" width="14" height="13" rx="2.5" fill="var(--rail-glyph-fill, none)" />
    <rect x="6" y="9" width="6" height="3" rx="1.5" stroke="var(--rail-glyph-detail, currentColor)" />
  </RailIcon>;
}

export function RailImageIcon(props: IconProps) {
  return <RailIcon {...props}>
    <rect x="3.5" y="5" width="17" height="14" rx="2.5" fill="var(--rail-glyph-fill, none)" />
    <circle cx="9" cy="10" r="1.5" stroke="var(--rail-glyph-detail, currentColor)" />
    <path d="m8 19 6.5-6.5a1.5 1.5 0 0 1 1.8-.25l4.2 2.25" stroke="var(--rail-glyph-detail, currentColor)" />
  </RailIcon>;
}

export function RailCanvasIcon(props: IconProps) {
  return <RailIcon {...props}>
    <path d="M7 7h10v4l-4 2-2 3H7Z" fill="var(--rail-glyph-fill, none)" stroke="none" />
    <path d="M7 3.5v17M17 3.5v7M3 7h18M3 16h8" />
    <path d="M17 13c.5 2 1.5 3 3.5 3.5-2 .5-3 1.5-3.5 3.5-.5-2-1.5-3-3.5-3.5 2-.5 3-1.5 3.5-3.5Z" fill="var(--rail-glyph-fill, none)" />
  </RailIcon>;
}

export function RailFolderIcon(props: IconProps) {
  return <RailIcon {...props}>
    <path d="M10.5 6h7a2 2 0 0 1 2 2v.5" />
    <path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h2a2 2 0 0 1 1.4.6l3 2.8a2 2 0 0 0 1.4.6H18a2.5 2.5 0 0 1 2.5 2.5v6a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 17Z" fill="var(--rail-glyph-fill, none)" />
    <path d="M7 16h4.5" stroke="var(--rail-glyph-detail, currentColor)" />
  </RailIcon>;
}
