/** Stroke icons for the rig panel (24 × 24, currentColor), same style as ../icons.tsx. */
import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
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

export const IconBone = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="4.5" r="2" />
    <path d="M12 6.5v6M12 8.5 7 11M12 8.5l5 2.5M12 12.5l-3 7M12 12.5l3 7" />
  </Icon>
);
export const IconPlay = (p: IconProps) => (
  <Icon {...p}><path d="M7 5v14l11-7z" fill="currentColor" stroke="none" /></Icon>
);
export const IconPause = (p: IconProps) => (
  <Icon {...p}><path d="M8 5v14M16 5v14" strokeWidth={3} /></Icon>
);
export const IconStop = (p: IconProps) => (
  <Icon {...p}><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" /></Icon>
);
export const IconLoop = (p: IconProps) => (
  <Icon {...p}><path d="M17 2l3 3-3 3" /><path d="M4 11V9a4 4 0 0 1 4-4h12" /><path d="M7 22l-3-3 3-3" /><path d="M20 13v2a4 4 0 0 1-4 4H4" /></Icon>
);
export const IconSearch = (p: IconProps) => (
  <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>
);
export const IconImport = (p: IconProps) => (
  <Icon {...p}><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M4 18v2h16v-2" /></Icon>
);
export const IconMove = (p: IconProps) => (
  <Icon {...p}><path d="M12 3v18M3 12h18" /><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" /></Icon>
);
