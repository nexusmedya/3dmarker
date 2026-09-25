/** Draws an RGBAImage into a <canvas> at its natural size (CSS scales it). */
import { useEffect, useRef } from 'react';
import type { RGBAImage } from '../core/types';

interface Props {
  image: RGBAImage;
  className?: string;
  label?: string;
}

export function RGBACanvas({ image, className, label }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const data = ctx.createImageData(image.width, image.height);
    data.data.set(image.data);
    ctx.putImageData(data, 0, 0);
  }, [image]);
  return <canvas ref={ref} className={className} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
