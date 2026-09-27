/**
 * Weight heat-map display: a vertex-colour override material for the
 * skinned meshes while painting. The colours live in an editor-only vertex
 * attribute (`rigHeat`, never exported — src/core/export stripEditorAttributes)
 * so the mesh's own vertex colours are untouched; the material is a
 * MeshBasicMaterial (skinning included) whose diffuse colour reads it.
 */
import { BufferAttribute, DoubleSide, MeshBasicMaterial } from 'three';
import type { Material, SkinnedMesh } from 'three';

export const HEAT_ATTRIBUTE = 'rigHeat';

export function createHeatMaterial(): MeshBasicMaterial {
  const m = new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide });
  m.name = 'rig-weight-heat';
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = `attribute vec3 ${HEAT_ATTRIBUTE};\nvarying vec3 vRigHeat;\n` + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n\tvRigHeat = ${HEAT_ATTRIBUTE};`);
    shader.fragmentShader = 'varying vec3 vRigHeat;\n' + shader.fragmentShader.replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( vRigHeat, opacity );');
  };
  m.customProgramCacheKey = () => 'rig-weight-heat';
  return m;
}

/** Shows / updates / removes the heat map on a rig's skinned meshes (vertex ranges in merged order). */
export class HeatOverlay {
  private readonly material = createHeatMaterial();
  private saved: Material | Material[] | null = null;
  private shown = false;
  readonly starts: number[];

  constructor(private readonly meshes: SkinnedMesh[]) {
    let s = 0;
    this.starts = meshes.map((m) => {
      const at = s;
      s += m.geometry.getAttribute('position').count;
      return at;
    });
  }

  get visible(): boolean {
    return this.shown;
  }

  /** Colours per merged input vertex (rgb). */
  show(colors: Float32Array): void {
    this.meshes.forEach((m, k) => {
      const n = m.geometry.getAttribute('position').count;
      const slice = colors.slice(this.starts[k] * 3, (this.starts[k] + n) * 3);
      const attr = m.geometry.getAttribute(HEAT_ATTRIBUTE) as BufferAttribute | undefined;
      if (attr && attr.count === n) {
        (attr.array as Float32Array).set(slice);
        attr.needsUpdate = true;
      } else m.geometry.setAttribute(HEAT_ATTRIBUTE, new BufferAttribute(slice, 3));
    });
    if (!this.shown) {
      this.saved = this.meshes.map((m) => m.material) as unknown as Material[];
      for (const m of this.meshes) m.material = this.material;
      this.shown = true;
    }
  }

  /** Update the colours of some merged input vertices. */
  update(vertices: Iterable<number>, colors: Float32Array): void {
    if (!this.shown) return;
    const touched = new Set<number>();
    for (const i of vertices) {
      let k = this.starts.length - 1;
      while (k > 0 && this.starts[k] > i) k--;
      const attr = this.meshes[k].geometry.getAttribute(HEAT_ATTRIBUTE) as BufferAttribute | undefined;
      if (!attr) continue;
      const l = i - this.starts[k];
      (attr.array as Float32Array).set(colors.subarray(i * 3, i * 3 + 3), l * 3);
      touched.add(k);
    }
    for (const k of touched) (this.meshes[k].geometry.getAttribute(HEAT_ATTRIBUTE) as BufferAttribute).needsUpdate = true;
  }

  hide(): void {
    if (!this.shown) return;
    const saved = this.saved as unknown as (Material | Material[])[];
    this.meshes.forEach((m, k) => {
      m.material = saved[k];
      m.geometry.deleteAttribute(HEAT_ATTRIBUTE);
    });
    this.saved = null;
    this.shown = false;
  }

  dispose(): void {
    this.hide();
    this.material.dispose();
  }
}
