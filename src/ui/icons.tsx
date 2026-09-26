/** Inline stroke icons (24 × 24, currentColor). */
import type { ReactNode, SVGProps } from 'react';

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

export const LogoMark = ({ size = 26 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <path fill="#7c5cff" d="M32 4 58 18v28L32 60 6 46V18z" />
    <path fill="#b9a8ff" d="M32 4 58 18 32 32 6 18z" />
    <path fill="#5a3de6" d="M32 32v28L6 46V18z" />
  </svg>
);

export const IconUpload = (p: IconProps) => (
  <Icon {...p}><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></Icon>
);
export const IconImage = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></Icon>
);
export const IconCube = (p: IconProps) => (
  <Icon {...p}><path d="M12 2 21 7v10l-9 5-9-5V7z" /><path d="m3 7 9 5 9-5" /><path d="M12 12v10" /></Icon>
);
export const IconSparkles = (p: IconProps) => (
  <Icon {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="m6 6 2 2M16 16l2 2M6 18l2-2M16 8l2-2" /></Icon>
);
export const IconX = (p: IconProps) => (
  <Icon {...p}><path d="M18 6 6 18M6 6l12 12" /></Icon>
);
export const IconSun = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Icon>
);
export const IconMoon = (p: IconProps) => (
  <Icon {...p}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></Icon>
);
export const IconGlobe = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" /></Icon>
);
export const IconGithub = (p: IconProps) => (
  <Icon {...p}><path d="M9 19c-4 1.5-4-2-6-2.5M15 22v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V22" /></Icon>
);
export const IconTexture = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></Icon>
);
export const IconWireframe = (p: IconProps) => (
  <Icon {...p}><path d="M12 2 21 7v10l-9 5-9-5V7z" /><path d="m3 7 18 10M21 7 3 17M12 2v20" /></Icon>
);
export const IconSphere = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M7.5 8.5a5 5 0 0 1 4-2.5" /></Icon>
);
export const IconRotate = (p: IconProps) => (
  <Icon {...p}><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></Icon>
);
export const IconFocus = (p: IconProps) => (
  <Icon {...p}><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" /><circle cx="12" cy="12" r="3" /></Icon>
);
export const IconContrast = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor" /></Icon>
);
export const IconLayers = (p: IconProps) => (
  <Icon {...p}><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></Icon>
);
export const IconDownload = (p: IconProps) => (
  <Icon {...p}><path d="M12 4v12" /><path d="m7 11 5 5 5-5" /><path d="M4 20h16" /></Icon>
);
export const IconAlert = (p: IconProps) => (
  <Icon {...p}><path d="M12 3 2 21h20z" /><path d="M12 10v5M12 18h.01" /></Icon>
);
export const IconInfo = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5h.01" /></Icon>
);
export const IconCheck = (p: IconProps) => (
  <Icon {...p}><path d="m5 12 5 5L20 7" /></Icon>
);
export const IconEye = (p: IconProps) => (
  <Icon {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Icon>
);
export const IconEyeOff = (p: IconProps) => (
  <Icon {...p}><path d="M3 3l18 18" /><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 4.4-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></Icon>
);
export const IconCpu = (p: IconProps) => (
  <Icon {...p}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></Icon>
);
export const IconCloud = (p: IconProps) => (
  <Icon {...p}><path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19.5 10 4 4 0 0 1 18 18z" /></Icon>
);
export const IconWand = (p: IconProps) => (
  <Icon {...p}><path d="m15 4 5 5L9 20l-5-5z" /><path d="m13 6 5 5" /></Icon>
);
export const IconChevron = (p: IconProps) => (
  <Icon {...p}><path d="m6 9 6 6 6-6" /></Icon>
);
export const IconShield = (p: IconProps) => (
  <Icon {...p}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /><path d="m9 12 2 2 4-4" /></Icon>
);
export const IconViews = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="4" width="7" height="7" rx="1.5" /><rect x="14" y="4" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></Icon>
);
export const IconBrush = (p: IconProps) => (
  <Icon {...p}><path d="M14.5 4.5 19.5 9.5 11 18l-5-5z" /><path d="M6 13c-2 0-3 1.5-3 3.5V20h3.5C8.5 20 10 19 10 17" /></Icon>
);
export const IconBone = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="4.5" r="2" /><path d="M12 6.5v6M12 12.5l-4 7M12 12.5l4 7M5 9.5h14" /></Icon>
);
export const IconArrowRight = (p: IconProps) => (
  <Icon {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Icon>
);
export const IconArrowLeft = (p: IconProps) => (
  <Icon {...p}><path d="M19 12H5M11 6l-6 6 6 6" /></Icon>
);
export const IconUndo = (p: IconProps) => (
  <Icon {...p}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></Icon>
);
export const IconPerson = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="6" r="3" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></Icon>
);
export const IconKey = (p: IconProps) => (
  <Icon {...p}><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M15 8l2 2" /></Icon>
);
