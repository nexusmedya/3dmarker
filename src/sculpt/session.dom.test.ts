// @vitest-environment jsdom
/**
 * Pointer handling of SculptSession in a DOM: strokes start only on the
 * mesh and then keep the viewer's own pointerdown listener (OrbitControls)
 * from seeing the event; drags in empty space reach it untouched.
 */
import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial } from 'three';
import { SculptSession } from './session';
import { fakeHost, gridGeometry } from './testing';

function setup() {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const orbitDowns: PointerEvent[] = [];
  // Registered before the session, on the canvas, like OrbitControls.
  canvas.addEventListener('pointerdown', (e) => orbitDowns.push(e));
  const core = fakeHost(canvas);
  const geometry = gridGeometry(16);
  const session = new SculptSession(core, new Mesh(geometry, new MeshBasicMaterial()));
  const fire = (type: string, x: number, y: number, init: PointerEventInit = {}) =>
    canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y, pointerType: 'mouse', ...init }));
  return { host, canvas, core, session, geometry, orbitDowns, fire };
}

describe('SculptSession pointer input', () => {
  it('strokes on the mesh without orbiting; empty-space drags still orbit', () => {
    const { session, core, orbitDowns, fire, geometry, canvas, host } = setup();
    fire('pointerdown', 50, 50);
    expect(session.stroking).toBe(false); // inactive: nothing happens
    expect(orbitDowns).toHaveLength(1);

    session.setActive(true);
    expect(core.overlays.size).toBe(1);
    const z0 = (geometry.getAttribute('position').array as Float32Array).slice();
    fire('pointerdown', 50, 50);
    expect(session.stroking).toBe(true);
    expect(orbitDowns).toHaveLength(1); // stopped before reaching the canvas listener
    expect(core.orbit.at(-1)).toBe(false);
    fire('pointermove', 56, 50);
    fire('pointerup', 56, 50);
    expect(session.stroking).toBe(false);
    expect(core.orbit.at(-1)).toBe(true);
    expect(session.state.strokes).toBe(1);
    expect(geometry.getAttribute('position').array).not.toEqual(z0);

    // Miss (outside the grid): the viewer gets it.
    fire('pointerdown', 2, 2);
    expect(session.stroking).toBe(false);
    expect(orbitDowns).toHaveLength(2);
    fire('pointerup', 2, 2);

    // Right button never sculpts.
    fire('pointerdown', 50, 50, { button: 2 });
    expect(session.stroking).toBe(false);
    expect(orbitDowns).toHaveLength(3);

    // Ctrl inverts for the stroke, Shift smooths.
    const before = (geometry.getAttribute('position').array as Float32Array).slice();
    fire('pointerdown', 50, 50, { ctrlKey: true });
    fire('pointerup', 50, 50);
    const after = geometry.getAttribute('position').array as Float32Array;
    let lowered = false;
    for (let i = 2; i < after.length; i += 3) if (after[i] < before[i]) lowered = true;
    expect(lowered).toBe(true);

    session.setActive(false);
    expect(core.overlays.size).toBe(0);
    fire('pointerdown', 50, 50);
    expect(session.stroking).toBe(false);
    expect(orbitDowns).toHaveLength(4);
    expect(canvas.style.cursor).toBe('');
    session.dispose();
    host.remove();
  });

  it('ignores shortcuts typed into inputs and dialogs', () => {
    const { session, host } = setup();
    session.setActive(true);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true, cancelable: true }));
    expect(session.settings.brush).toBe('draw');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const button = document.createElement('button');
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    button.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true, cancelable: true }));
    expect(session.settings.brush).toBe('draw');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true, cancelable: true }));
    expect(session.settings.brush).toBe('smooth');
    session.dispose();
    input.remove();
    dialog.remove();
    host.remove();
  });
});
