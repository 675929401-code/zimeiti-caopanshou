import type {SVGProps} from 'react';

// Paths measured from public chunks: 30083 (save), 663.vi (library), 21336 (expand).
export function ImageEditorIcon({kind,...props}:SVGProps<SVGSVGElement>&{kind:'save'|'library'|'expand'}) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" width={16} height={16} aria-hidden="true" {...props}>
    {kind==='save'?<path d="M9 3.75H6.912a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H15M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859M12 3v8.25m0 0-3-3m3 3 3-3"/>:kind==='expand'?<path d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15"/>:<>
      <rect x="3.75" y="4.75" width="4.75" height="4.75" rx="0.85"/>
      <rect x="3.75" y="14.5" width="4.75" height="4.75" rx="0.85"/>
      <line x1="10.75" y1="6.5" x2="20.25" y2="6.5"/>
      <line x1="10.75" y1="9.25" x2="19.75" y2="9.25"/>
      <line x1="10.75" y1="16.25" x2="20.25" y2="16.25"/>
      <line x1="10.75" y1="19" x2="19.75" y2="19"/>
    </>}
  </svg>;
}
