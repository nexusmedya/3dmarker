import { describe, expect, it } from 'vitest';
import { getStyle, STYLE_CATEGORIES, STYLE_KEEP, STYLES } from './styles';

describe('STYLES', () => {
  it('has at least 48 presets with unique ids', () => {
    expect(STYLES.length).toBeGreaterThanOrEqual(48);
    expect(new Set(STYLES.map((s) => s.id)).size).toBe(STYLES.length);
    for (const s of STYLES) expect(s.id).toMatch(/^[a-z0-9-]+$/);
  });

  it('covers every category with bilingual names and gradient swatches', () => {
    const cats = new Set(STYLE_CATEGORIES.map((c) => c.id));
    for (const c of STYLE_CATEGORIES) expect(STYLES.filter((s) => s.category === c.id).length).toBeGreaterThanOrEqual(5);
    for (const s of STYLES) {
      expect(cats.has(s.category)).toBe(true);
      expect(s.name.tr.trim()).not.toBe('');
      expect(s.name.en.trim()).not.toBe('');
      expect(s.swatch).toMatch(/^linear-gradient\(/);
    }
  });

  it('keeps identity / pose / composition and asks for a reconstruction-friendly render', () => {
    expect(STYLE_KEEP).toMatch(/identity/);
    expect(STYLE_KEEP).toMatch(/pose and composition/);
    expect(STYLE_KEEP).toMatch(/3D reconstruction/);
    for (const s of STYLES) expect(s.prompt.endsWith(STYLE_KEEP)).toBe(true);
  });

  it('looks presets up by id', () => {
    expect(getStyle('marble')?.category).toBe('material');
    expect(getStyle(null)).toBeNull();
    expect(getStyle('nope')).toBeNull();
  });
});
