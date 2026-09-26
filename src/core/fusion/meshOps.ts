/**
 * Mesh post-processing for the fused surface: vertex adjacency (CSR),
 * Taubin λ/μ smoothing (shrink-free Laplacian smoothing), area-weighted
 * vertex normals and rescaling into the shared frame. Typed arrays only.
 */

export interface Adjacency {
  /** Neighbours of v are neighbors[offsets[v] .. offsets[v + 1]). */
  offsets: Int32Array;
  neighbors: Int32Array;
}

/**
 * One-ring neighbours from the triangles' directed edges. On a closed,
 * consistently oriented manifold every undirected edge appears once per
 * direction, so each neighbour is listed exactly once.
 */
export function buildAdjacency(vertexCount: number, indices: Uint32Array): Adjacency {
  const offsets = new Int32Array(vertexCount + 1);
  for (let t = 0; t < indices.length; t += 3) {
    offsets[indices[t] + 1]++;
    offsets[indices[t + 1] + 1]++;
    offsets[indices[t + 2] + 1]++;
  }
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] += offsets[v];
  const fill = offsets.slice(0, vertexCount);
  const neighbors = new Int32Array(offsets[vertexCount]);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    neighbors[fill[a]++] = b;
    neighbors[fill[b]++] = c;
    neighbors[fill[c]++] = a;
  }
  return { offsets, neighbors };
}

/** Taubin smoothing in place: per iteration x += λ·L(x), then x += μ·L(x) with the uniform Laplacian. */
export function taubinSmooth(positions: Float32Array, adj: Adjacency, iterations: number, lambda = 0.5, mu = -0.53): void {
  const n = positions.length / 3;
  const tmp = new Float32Array(positions.length);
  const { offsets, neighbors } = adj;
  const pass = (src: Float32Array, dst: Float32Array, f: number) => {
    for (let v = 0; v < n; v++) {
      const s = offsets[v], e = offsets[v + 1];
      const o = v * 3;
      if (e === s) {
        dst[o] = src[o]; dst[o + 1] = src[o + 1]; dst[o + 2] = src[o + 2];
        continue;
      }
      let x = 0, y = 0, z = 0;
      for (let q = s; q < e; q++) {
        const u = neighbors[q] * 3;
        x += src[u]; y += src[u + 1]; z += src[u + 2];
      }
      const inv = 1 / (e - s);
      dst[o] = src[o] + f * (x * inv - src[o]);
      dst[o + 1] = src[o + 1] + f * (y * inv - src[o + 1]);
      dst[o + 2] = src[o + 2] + f * (z * inv - src[o + 2]);
    }
  };
  for (let it = 0; it < iterations; it++) {
    pass(positions, tmp, lambda);
    pass(tmp, positions, mu);
  }
}

/** Area-weighted, normalised vertex normals of an indexed triangle mesh. */
export function vertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }
  for (let o = 0; o < normals.length; o += 3) {
    const len = Math.hypot(normals[o], normals[o + 1], normals[o + 2]);
    if (len > 0) {
      normals[o] /= len; normals[o + 1] /= len; normals[o + 2] /= len;
    } else normals[o + 2] = 1;
  }
  return normals;
}

/** Centre the positions' bounding box on the origin and scale its longest side to `size` (in place). */
export function fitToFrame(positions: Float32Array, size = 2): void {
  if (positions.length === 0) return;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let o = 0; o < positions.length; o += 3)
    for (let a = 0; a < 3; a++) {
      const v = positions[o + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  const longest = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const s = longest > 0 ? size / longest : 1;
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  for (let o = 0; o < positions.length; o += 3)
    for (let a = 0; a < 3; a++) positions[o + a] = (positions[o + a] - c[a]) * s;
}
