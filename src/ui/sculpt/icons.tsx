/** Stroke icons for the sculpt and depth tools (24 × 24, currentColor), same style as ../icons. */
import type { ReactNode, SVGProps } from 'react';
import type { BrushId } from '../../sculpt/types';
import type { DepthBrushId } from '../../sculpt/depthBrush';

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

export const IconSculpt = (p: IconProps) => (
  <Icon {...p}><path d="M3 20c3 0 4-5 9-5s6 5 9 5" /><path d="m14 3 3 3-6 6H8V9z" /></Icon>
);
export const IconUndo = (p: IconProps) => (
  <Icon {...p}><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></Icon>
);
export const IconRedo = (p: IconProps) => (
  <Icon {...p}><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></Icon>
);
export const IconReset = (p: IconProps) => (
  <Icon {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></Icon>
);
export const IconMirror = (p: IconProps) => (
  <Icon {...p}><path d="M12 3v18" strokeDasharray="2 2" /><path d="M9 7 4 12l5 5z" /><path d="m15 7 5 5-5 5z" /></Icon>
);
export const IconInvert = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="8" /><path d="M8 12h8" /></Icon>
);
export const IconLock = (p: IconProps) => (
  <Icon {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Icon>
);
export const IconKeyboard = (p: IconProps) => (
  <Icon {...p}><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></Icon>
);
export const IconZoomFit = (p: IconProps) => (
  <Icon {...p}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Icon>
);
export const IconCompare = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /><path d="M12 8h9" opacity=".4" /></Icon>
);

const BRUSH_ICONS: Record<BrushId, ReactNode> = {
  draw: <><path d="M3 18h18" opacity=".45" /><path d="M3 18c4 0 5-9 9-9s5 9 9 9" /></>,
  clay: <><path d="M3 19h18" /><path d="M5 15h14" /><path d="M8 11h8" /></>,
  smooth: <><path d="M3 9c2-3 4-3 6 0s4 3 6 0 4-3 6 0" opacity=".45" /><path d="M3 16c3-1.5 6-1.5 9 0s6 1.5 9 0" /></>,
  flatten: <><path d="M4 17h16" /><path d="M8 5v7M16 5v7" /><path d="m6 10 2 2 2-2M14 10l2 2 2-2" /></>,
  inflate: <><circle cx="12" cy="12" r="4" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></>,
  pinch: <><path d="M3 12h6M15 12h6" /><path d="m6 9 3 3-3 3M18 9l-3 3 3 3" /></>,
  grab: <><path d="M12 3v18M3 12h18" /><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" /></>,
  crease: <><path d="M3 8h5l4 9 4-9h5" /></>,
};

export const BrushIcon = ({ brush, ...p }: IconProps & { brush: BrushId }) => <Icon {...p}>{BRUSH_ICONS[brush]}</Icon>;

const DEPTH_ICONS: Record<DepthBrushId, ReactNode> = {
  raise: <><path d="M12 19V5" /><path d="m6 11 6-6 6 6" /></>,
  lower: <><path d="M12 5v14" /><path d="m6 13 6 6 6-6" /></>,
  smooth: BRUSH_ICONS.smooth,
  flatten: BRUSH_ICONS.flatten,
  erase: <><path d="m7 21-4-4 10-10 7 7-7 7z" /><path d="M7 21h13" /><path d="m9 11 7 7" /></>,
};

export const DepthBrushIcon = ({ brush, ...p }: IconProps & { brush: DepthBrushId }) => <Icon {...p}>{DEPTH_ICONS[brush]}</Icon>;
