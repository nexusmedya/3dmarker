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
 *
 * Extension points for tools that live on top of the viewer (sculpting,
 * rigging / animation): `addFrameListener` (per-frame callback; return true
 * while something animates so frames keep rendering), `invalidate`,
 * `getObject`, `canvas`, `setOrbitEnabled` and `addOverlay` /
 * `removeOverlay` for helpers (brush cursor, skeleton) that the viewer shows
 * but does not own (the caller disposes them).
 */
import {
  ACESFilmicToneMapping,
  Bone,
  Box3,
  BoxGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  GridHelper,
  Group,
  Mesh,
  MeshMatcapMaterial,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  RGBAFormat,
  SRGBColorSpace,
  Scene,
  ShadowMaterial,
  Skeleton,
  SkinnedMesh,
  Sphere,
  Uint16BufferAttribute,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Material, Object3D, Texture, WebGLRenderTarget } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { rebindSkinnedClones } from '../core/export/exporters';
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

/** Camera presets, in the fusion's view conventions (src/core/fusion/frame.ts: the left view's camera sits at +X). */
export type ViewPreset = 'front' | 'back' | 'left' | 'right' | 'top';
export const VIEW_PRESETS: ViewPreset[] = ['front', 'back', 'left', 'right', 'top'];
const PRESET_DIRS: Record<ViewPreset, Vector3> = {
  front: new Vector3(0, 0, 1),
  back: new Vector3(0, 0, -1),
  left: new Vector3(1, 0, 0),
  right: new Vector3(-1, 0, 0),
  // A hair towards the front keeps OrbitControls off the pole (the subject's front at the screen bottom).
  top: new Vector3(0, 1, 0.001).normalize(),
};

/** Touch screens: one-finger vertical swipes scroll the page, horizontal ones orbit. */
const coarsePointer = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

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
  private readonly frameListeners = new Set<(dt: number) => boolean | void>();
  private readonly overlays = new Group();
  private lastTick = 0;
  private disposed = false;
  /** Warm-up materials kept so their compiled programs stay in three.js' cache (see warmUpShaders). */
  private warmMaterials: { mats: Material[]; tex: DataTexture } | null = null;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly intersectionObserver: IntersectionObserver | null = null;
  /** Canvas pixels at the top covered by floating UI (the toolbar); framing keeps the model below them. */
  private insetTop = 0;

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
    this.setTouchScroll(true);
    // Info-log queries force every shader program to link synchronously; only worth it while developing.
    renderer.debug.checkShaderErrors = !!import.meta.env?.DEV;
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
    this.overlays.name = 'overlays';
    this.scene.add(this.ground, this.root, this.overlays);

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
    this.warmUpShaders();
  }

  /**
   * Compile the programs of the usual model materials (textured / vertex
   * colours, front / double sided, skinned, clay) in the background, so the
   * first model on screen does not stall the page while they link. The
   * throwaway meshes sit far outside the view and leave once compiled; their
   * materials stay alive (until dispose) so three.js keeps the programs cached
   * and a new model (e.g. a re-run fusion replacing the old one) does not
   * relink them on its first frame.
   */
  private warmUpShaders(): void {
    const compileAsync = (this.renderer as { compileAsync?: WebGLRenderer['compileAsync'] }).compileAsync;
    if (typeof compileAsync !== 'function' || typeof this.renderer.compile !== 'function') return;
    const tex = new DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, RGBAFormat);
    tex.colorSpace = SRGBColorSpace;
    tex.needsUpdate = true;
    const geo = new BoxGeometry(0.01, 0.01, 0.01);
    geo.setAttribute('color', geo.getAttribute('position').clone());
    const mats: Material[] = [];
    const std = (p: ConstructorParameters<typeof MeshStandardMaterial>[0]) => {
      const m = new MeshStandardMaterial({ roughness: 0.8, metalness: 0, ...p });
      mats.push(m);
      return m;
    };
    const group = new Group();
    group.position.set(1e6, 1e6, 1e6); // never inside the frustum
    const meshes: Mesh[] = [
      new Mesh(geo, std({ map: tex, side: FrontSide })),
      new Mesh(geo, std({ map: tex, side: DoubleSide })),
      new Mesh(geo, std({ vertexColors: true, side: FrontSide })),
      new Mesh(geo, std({ vertexColors: true, side: DoubleSide })),
      new Mesh(geo, this.clay),
    ];
    const bone = new Bone();
    const skinned = new SkinnedMesh(geo.clone(), std({ map: tex, side: DoubleSide }));
    const n = skinned.geometry.getAttribute('position').count;
    skinned.geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(n * 4), 4));
    skinned.geometry.setAttribute('skinWeight', new Float32BufferAttribute(new Float32Array(n * 4).fill(0.25), 4));
    skinned.add(bone);
    skinned.bind(new Skeleton([bone]));
    meshes.push(skinned);
    for (const m of meshes) {
      m.castShadow = true;
      group.add(m);
    }
    this.scene.add(group);
    const done = () => {
      this.scene.remove(group);
      geo.dispose();
      skinned.geometry.dispose();
      skinned.skeleton.dispose();
      if (this.disposed) {
        for (const m of mats) m.dispose();
        tex.dispose();
      } else this.warmMaterials = { mats, tex };
    };
    if (this.renderer.extensions.has('KHR_parallel_shader_compile')) {
      compileAsync.call(this.renderer, this.scene, this.camera).then(done, done);
      return;
    }
    // No parallel compile: issue the compiles once the page is idle (without error
    // checks nothing waits for them to finish; the driver links in the background).
    const idle = (cb: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(cb, { timeout: 2000 }) : setTimeout(cb, 200));
    idle(() => {
      try {
        if (!this.disposed) this.renderer.compile(this.scene, this.camera);
      } catch {
        // Warm-up only.
      }
      done();
    });
  }

  private readonly tick = (time?: number) => {
    if (!this.visible || this.disposed) return;
    const now = typeof time === 'number' ? time : performance.now();
    const dt = this.lastTick ? Math.min(0.1, (now - this.lastTick) / 1000) : 0;
    this.lastTick = now;
    let animating = false;
    for (const fn of this.frameListeners) if (fn(dt) === true) animating = true;
    const moved = this.controls.update();
    if (moved || this.dirty || animating) {
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

  /** The canvas the viewer renders into (pointer events for tools). */
  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** The object on screen (the one passed to setObject), or null. */
  getObject(): Object3D | null {
    return this.object;
  }

  /** Request a render on the next frame (after editing geometry / transforms in place). */
  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Call `fn(dt)` every frame (dt in seconds, clamped to 0.1). Return true
   * while it animates to keep frames rendering. Returns the unsubscribe.
   */
  addFrameListener(fn: (dt: number) => boolean | void): () => void {
    this.frameListeners.add(fn);
    this.dirty = true;
    return () => {
      this.frameListeners.delete(fn);
      this.dirty = true;
    };
  }

  /** Enable / disable orbiting (e.g. while a sculpt stroke or joint drag is in progress). */
  setOrbitEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
  }

  /** Show a helper (not owned: never disposed by the viewer; call removeOverlay then dispose it yourself). */
  addOverlay(obj: Object3D): void {
    this.overlays.add(obj);
    this.dirty = true;
  }

  removeOverlay(obj: Object3D): void {
    this.overlays.remove(obj);
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

  /**
   * Call after meshes were added to / removed from the object in place (e.g.
   * the rig swapping meshes for skinned copies): meshes that left the tree get
   * their original material back and are forgotten, new ones are registered
   * with their current material as the original; then like refresh().
   */
  rescanObject(): void {
    const obj = this.object;
    if (!obj) return;
    const current = new Set(meshesOf(obj));
    for (const [mesh, mat] of this.originals) {
      if (current.has(mesh)) continue;
      mesh.material = mat;
      this.originals.delete(mesh);
    }
    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    for (const mesh of current) {
      if (this.originals.has(mesh)) continue;
      this.originals.set(mesh, mesh.material);
      mesh.castShadow = true;
      for (const m of materialsOf(mesh)) {
        const map = (m as Material & { map?: Texture | null }).map;
        if (map) map.anisotropy = aniso;
      }
    }
    this.refresh();
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

  /** Look at the model straight from one side (orthogonal to it), refitted. */
  viewFrom(preset: ViewPreset): void {
    this.fitCamera(PRESET_DIRS[preset]);
  }

  /**
   * Floating UI over the canvas: the top `top` px stay free of the model when
   * framing (fit / reset / presets). Applies from the next fit.
   */
  setFrameInsets({ top }: { top: number }): void {
    this.insetTop = Number.isFinite(top) ? Math.max(0, top) : 0;
  }

  /**
   * Whether a one-finger vertical swipe may scroll the page (touch screens
   * only; tools that need every touch, like sculpting, turn it off).
   */
  setTouchScroll(allow: boolean): void {
    this.renderer.domElement.style.touchAction = allow && coarsePointer() ? 'pan-y' : 'none';
  }

  /**
   * Clone of the current object (sharing geometries / textures) carrying the
   * original materials, whatever the display mode — for the exporters.
   * Skinned meshes are re-bound to the cloned bones (a plain clone() keeps
   * pointing at the on-screen skeleton).
   */
  getExportObject(): Object3D | null {
    const obj = this.object;
    if (!obj) return null;
    const clone = obj.clone(true);
    const src = meshesOf(obj), dst = meshesOf(clone);
    for (let i = 0; i < src.length && i < dst.length; i++) dst[i].material = this.originals.get(src[i]) ?? src[i].material;
    if (src.some((m) => (m as SkinnedMesh).isSkinnedMesh)) rebindSkinnedClones(obj, clone);
    return clone;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.frameListeners.clear();
    this.scene.remove(this.overlays);
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.clearObject();
    this.controls.dispose();
    this.clay.dispose();
    this.clayMatcap.dispose();
    if (this.warmMaterials) {
      for (const m of this.warmMaterials.mats) m.dispose();
      this.warmMaterials.tex.dispose();
      this.warmMaterials = null;
    }
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

  private fitCamera(dir: Vector3 = VIEW_DIR): void {
    const box = this.bounds();
    const sphere = box.getBoundingSphere(new Sphere());
    const r = Math.max(sphere.radius, 0.05);
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    // Only the canvas below the floating toolbar counts vertically.
    const h = this.container.clientHeight;
    const free = h > 0 ? Math.min(1, Math.max(0.5, (h - this.insetTop) / h)) : 1;
    const vFit = 2 * Math.atan(Math.tan(vFov / 2) * free);
    const dist = (r / Math.sin(Math.min(vFit, hFov) / 2)) * 1.08;
    // Centre the model in the free area: raise the view by half the inset.
    const shift = dist * Math.tan(vFov / 2) * (1 - free);
    const up = this.camera.up.clone().addScaledVector(dir, -dir.dot(this.camera.up));
    if (up.lengthSq() > 1e-12) up.normalize();
    const target = sphere.center.clone().addScaledVector(up, shift);
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.001, dist / 100);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(target);
    this.controls.minDistance = r * 0.25;
    this.controls.maxDistance = dist * 6;
    this.controls.update();
    this.dirty = true;
  }
}
