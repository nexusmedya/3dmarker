/**
 * Plain three.js viewer: WebGLRenderer (sRGB, ACES), PMREM room environment,
 * a key light with a soft ground shadow, a subtle grid and damped orbit
 * controls. Renders on demand (only while something changes).
 *
 * Ownership: `setObject` takes ownership of the object and disposes the
 * previous one (geometries, materials, textures); `dispose` releases
 * everything, including the renderer. Display modes (texture off,
 * wireframe, clay) swap in display materials and never mutate the originals,
 * so `getExportObject` can hand the exporters the pristine materials.
 */
import {
  ACESFilmicToneMapping,
  Box3,
  Color,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  Mesh,
  MeshMatcapMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  RGBAFormat,
  SRGBColorSpace,
  Scene,
  ShadowMaterial,
  Sphere,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Material, Object3D, Texture, WebGLRenderTarget } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { disposeObject, materialsOf } from './dispose';

export interface ViewerDisplay {
  texture: boolean;
  wireframe: boolean;
  clay: boolean;
  autoRotate: boolean;
  darkBackground: boolean;
}

export const DEFAULT_DISPLAY: ViewerDisplay = {
  texture: true,
  wireframe: false,
  clay: false,
  autoRotate: false,
  darkBackground: true,
};

const BACKGROUND = { dark: 0x0f1218, light: 0xeef0f4 };
const GRID_COLORS = { dark: [0x3b4252, 0x232833], light: [0xaab1bf, 0xd3d7df] } as const;
/** Initial camera direction: slightly right and above the front (+Z) view. */
const VIEW_DIR = new Vector3(0.42, 0.28, 1).normalize();

/**
 * Procedural clay matcap (warm diffuse + soft specular + rim), 128² sRGB.
 * Row 0 is the bottom of the sphere (flipY = false), as the matcap shader expects.
 */
export function createClayMatcap(size = 128): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const light = new Vector3(-0.45, 0.6, 0.66).normalize();
  const half = light.clone().add(new Vector3(0, 0, 1)).normalize();
  const base = [0.8, 0.68, 0.6];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let nx = ((i + 0.5) / size) * 2 - 1;
      let ny = ((j + 0.5) / size) * 2 - 1;
      const r2 = nx * nx + ny * ny;
      if (r2 > 1) {
        const r = Math.sqrt(r2);
        nx /= r;
        ny /= r;
      }
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const diffuse = Math.max(0, nx * light.x + ny * light.y + nz * light.z);
      const spec = Math.pow(Math.max(0, nx * half.x + ny * half.y + nz * half.z), 36);
      const rim = Math.pow(1 - nz, 3);
      const o = (j * size + i) * 4;
      for (let c = 0; c < 3; c++) {
        const v = base[c] * (0.22 + 0.78 * diffuse) + spec * 0.35 + rim * 0.12;
        data[o + c] = Math.round(Math.min(1, v) * 255);
      }
      data[o + 3] = 255;
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat);
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  tex.name = 'clay-matcap';
  return tex;
}

function meshesOf(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh);
  });
  return out;
}

export class ViewerCore {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(35, 1, 0.01, 100);
  readonly controls: OrbitControls;

  private readonly root = new Group();
  private object: Object3D | null = null;
  private readonly originals = new Map<Mesh, Material | Material[]>();
  private readonly displayClones = new Map<Material, Material>();
  private readonly clayMatcap = createClayMatcap();
  private readonly clay = new MeshMatcapMaterial({ matcap: this.clayMatcap, side: DoubleSide });
  private readonly envTarget: WebGLRenderTarget;
  private readonly keyLight = new DirectionalLight(0xffffff, 1.0);
  private readonly ground: Mesh<PlaneGeometry, ShadowMaterial>;
  private grid: GridHelper | null = null;
  private display: ViewerDisplay;
  private dirty = true;
  private visible = true;
  private disposed = false;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly intersectionObserver: IntersectionObserver | null = null;

  constructor(
    private readonly container: HTMLElement,
    display: Partial<ViewerDisplay> = {},
  ) {
    this.display = { ...DEFAULT_DISPLAY, ...display };
    const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.touchAction = 'none';
    container.appendChild(renderer.domElement);

    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.envTarget = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.7;

    const light = this.keyLight;
    light.position.set(2.5, 4, 3);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.02;
    light.shadow.radius = 6;
    this.scene.add(light, light.target);

    this.ground = new Mesh(new PlaneGeometry(40, 40), new ShadowMaterial({ opacity: 0.25 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.position.y = -1;
    this.scene.add(this.ground, this.root);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotateSpeed = 1.6;
    this.controls.addEventListener('change', () => (this.dirty = true));

    this.applyBackground();
    this.fitCamera();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver((entries) => {
        this.visible = entries.some((e) => e.isIntersecting);
        if (this.visible) this.dirty = true;
      });
      this.intersectionObserver.observe(container);
    }
    this.resize();
    renderer.setAnimationLoop(this.tick);
  }

  private readonly tick = () => {
    if (!this.visible || this.disposed) return;
    const moved = this.controls.update();
    if (moved || this.dirty) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
  };

  private resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w <= 0 || h <= 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  /** Show `obj` (taking ownership; the previous object is disposed). Pass null to clear. */
  setObject(obj: Object3D | null): void {
    if (obj === this.object) {
      this.refresh();
      return;
    }
    this.clearObject();
    if (obj) {
      this.object = obj;
      const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      for (const mesh of meshesOf(obj)) {
        this.originals.set(mesh, mesh.material);
        mesh.castShadow = true;
        for (const m of materialsOf(mesh)) {
          const map = (m as Material & { map?: Texture | null }).map;
          if (map) map.anisotropy = aniso;
        }
      }
      this.root.add(obj);
      this.applyDisplay();
      this.updateBounds();
      this.fitCamera();
    }
    this.dirty = true;
  }

  /** Call after the object's geometry or materials changed in place (e.g. re-meshing). */
  refresh(): void {
    this.applyDisplay();
    this.updateBounds();
    this.dirty = true;
  }

  setDisplay(patch: Partial<ViewerDisplay>): void {
    const prev = this.display;
    this.display = { ...prev, ...patch };
    this.controls.autoRotate = this.display.autoRotate;
    if (prev.darkBackground !== this.display.darkBackground || !this.grid) this.applyBackground();
    this.applyDisplay();
    this.dirty = true;
  }

  resetView(): void {
    this.fitCamera();
    this.dirty = true;
  }

  /**
   * Clone of the current object (sharing geometries / textures) carrying the
   * original materials, whatever the display mode — for the exporters.
   */
  getExportObject(): Object3D | null {
    const obj = this.object;
    if (!obj) return null;
    const clone = obj.clone(true);
    const src = meshesOf(obj), dst = meshesOf(clone);
    for (let i = 0; i < src.length && i < dst.length; i++) dst[i].material = this.originals.get(src[i]) ?? src[i].material;
    return clone;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.clearObject();
    this.controls.dispose();
    this.clay.dispose();
    this.clayMatcap.dispose();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.disposeGrid();
    this.envTarget.dispose();
    this.scene.environment = null;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private clearObject(): void {
    const obj = this.object;
    if (!obj) return;
    for (const [mesh, mat] of this.originals) mesh.material = mat;
    this.root.remove(obj);
    disposeObject(obj);
    for (const clone of this.displayClones.values()) clone.dispose(); // textures are shared with the originals
    this.displayClones.clear();
    this.originals.clear();
    this.object = null;
  }

  private displayMaterial(original: Material): Material {
    const { texture, wireframe } = this.display;
    const orig = original as Material & { map?: Texture | null; wireframe?: boolean };
    const needsClone = (!texture && !!orig.map) || (wireframe && 'wireframe' in orig);
    if (!needsClone) return original;
    let clone = this.displayClones.get(original) as (Material & { map?: Texture | null; wireframe?: boolean }) | undefined;
    if (!clone) {
      clone = original.clone() as Material & { map?: Texture | null; wireframe?: boolean };
      this.displayClones.set(original, clone);
    }
    const map = texture ? (orig.map ?? null) : null;
    if (clone.map !== map || clone.wireframe !== wireframe || clone.side !== original.side) {
      clone.map = map;
      clone.wireframe = wireframe;
      clone.side = original.side;
      clone.needsUpdate = true;
    }
    return clone;
  }

  private applyDisplay(): void {
    this.controls.autoRotate = this.display.autoRotate;
    this.clay.wireframe = this.display.wireframe;
    this.clay.side = DoubleSide; // shared by every model: never inherit a side set from outside
    for (const [mesh, original] of this.originals) {
      if (this.display.clay) mesh.material = this.clay;
      else mesh.material = Array.isArray(original) ? original.map((m) => this.displayMaterial(m)) : this.displayMaterial(original);
    }
  }

  private applyBackground(): void {
    const dark = this.display.darkBackground;
    this.scene.background = new Color(dark ? BACKGROUND.dark : BACKGROUND.light);
    this.ground.material.opacity = dark ? 0.4 : 0.2;
    const y = this.grid?.position.y ?? this.ground.position.y;
    this.disposeGrid();
    const [center, line] = dark ? GRID_COLORS.dark : GRID_COLORS.light;
    const grid = new GridHelper(12, 24, center, line);
    const mats = Array.isArray(grid.material) ? grid.material : [grid.material];
    for (const m of mats) {
      m.transparent = true;
      m.opacity = 0.55;
      m.depthWrite = false;
    }
    grid.position.y = y;
    grid.renderOrder = -1;
    this.grid = grid;
    this.scene.add(grid);
    this.dirty = true;
  }

  private disposeGrid(): void {
    if (!this.grid) return;
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    const mats = Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material];
    mats.forEach((m) => m.dispose());
    this.grid = null;
  }

  private bounds(): Box3 {
    const box = new Box3();
    if (this.object) box.setFromObject(this.object);
    if (box.isEmpty()) box.set(new Vector3(-1, -1, -0.2), new Vector3(1, 1, 0.2));
    return box;
  }

  /** Put the ground under the object and fit the shadow camera around it. */
  private updateBounds(): void {
    const box = this.bounds();
    const sphere = box.getBoundingSphere(new Sphere());
    const floor = box.min.y - 0.002;
    this.ground.position.y = floor;
    if (this.grid) this.grid.position.y = floor;
    const r = Math.max(sphere.radius, 0.1);
    const light = this.keyLight;
    light.target.position.copy(sphere.center);
    light.position.copy(sphere.center).add(new Vector3(0.6, 1, 0.75).normalize().multiplyScalar(r * 4));
    const cam = light.shadow.camera;
    cam.left = -r * 1.6;
    cam.right = r * 1.6;
    cam.top = r * 1.6;
    cam.bottom = -r * 1.6;
    cam.near = r * 0.5;
    cam.far = r * 8;
    cam.updateProjectionMatrix();
    light.target.updateMatrixWorld();
  }

  private fitCamera(): void {
    const box = this.bounds();
    const sphere = box.getBoundingSphere(new Sphere());
    const r = Math.max(sphere.radius, 0.05);
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const dist = (r / Math.sin(Math.min(vFov, hFov) / 2)) * 1.08;
    this.camera.position.copy(sphere.center).addScaledVector(VIEW_DIR, dist);
    this.camera.near = Math.max(0.001, dist / 100);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(sphere.center);
    this.controls.minDistance = r * 0.25;
    this.controls.maxDistance = dist * 6;
    this.controls.update();
    this.dirty = true;
  }
}
