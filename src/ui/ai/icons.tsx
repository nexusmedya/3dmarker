/** Stroke icons of the AI UI (24 × 24, currentColor), same style as ../icons. */
import type { ReactNode, SVGProps } from 'react';
import type { ProviderKindId } from '../../ai/types';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 18, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconSearch = (p: IconProps) => (
  <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>
);
export const IconPlus = (p: IconProps) => (
  <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>
);
export const IconTrash = (p: IconProps) => (
  <Icon {...p}><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></Icon>
);
export const IconExternal = (p: IconProps) => (
  <Icon {...p}><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Icon>
);
export const IconKey = (p: IconProps) => (
  <Icon {...p}><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9" /><path d="m17 6 3 3" /><path d="m15 8 2 2" /></Icon>
);
export const IconServer = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></Icon>
);
export const IconPlug = (p: IconProps) => (
  <Icon {...p}><path d="M9 3v5M15 3v5" /><path d="M6 8h12v3a6 6 0 0 1-12 0z" /><path d="M12 17v4" /></Icon>
);
export const IconSettings = (p: IconProps) => (
  <Icon {...p}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></Icon>
);
export const IconPalette = (p: IconProps) => (
  <Icon {...p}><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.9 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.4 17 3 12 3z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10" cy="7" r="1" /><circle cx="15" cy="7.5" r="1" /></Icon>
);
export const IconPerson = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="5" r="2.2" /><path d="M4 9.5h16" /><path d="M12 9.5v5.5" /><path d="m12 15-3 6M12 15l3 6" /></Icon>
);
export const IconViews = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></Icon>
);
export const IconCompare = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 2v20" /><path d="m8 10-2 2 2 2M16 10l2 2-2 2" /></Icon>
);
export const IconColumns = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="5" width="7.5" height="14" rx="1.5" /><rect x="13.5" y="5" width="7.5" height="14" rx="1.5" /></Icon>
);
export const IconBan = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="8" /><path d="m6.5 6.5 11 11" /></Icon>
);

/** Short neutral monograms and hues per provider kind (no brand logos). */
const KIND_MARKS: Record<ProviderKindId, { text: string; hue: number }> = {
  openai: { text: 'OA', hue: 160 },
  gemini: { text: 'G', hue: 215 },
  stability: { text: 'St', hue: 275 },
  replicate: { text: 'R', hue: 10 },
  fal: { text: 'fal', hue: 300 },
  tripo: { text: '3D', hue: 38 },
  'openai-compatible': { text: '{ }', hue: 190 },
  'custom-http': { text: '</>', hue: 230 },
};

/** Rounded monogram tile for a provider kind. */
export function KindMark({ kind, size = 32 }: { kind: ProviderKindId; size?: number }) {
  const mark = KIND_MARKS[kind] ?? { text: '?', hue: 250 };
  return (
    <span
      className="ai-kindmark"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * (mark.text.length > 2 ? 0.3 : 0.38)), ['--hue' as string]: mark.hue }}
    >
      {mark.text}
    </span>
  );
}
