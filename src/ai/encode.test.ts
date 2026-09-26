import { describe, expect, it } from 'vitest';
import { base64ToBlob, base64ToBytes, blobToBase64, blobToDataUri, bytesToBase64, dataUriToBlob, isGlbBuffer, sniffType, toUploadPng, withSniffedType } from './encode';
import { glbBytes, PNG_BASE64, pngBlob } from './testing';

describe('base64', () => {
  it('round-trips bytes, including large buffers', async () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(await blobToBase64(new Blob([bytes]))).toBe(bytesToBase64(bytes));
  });
});

describe('sniffType', () => {
  it('recognises PNG, JPEG, WEBP, GIF and GLB', () => {
    expect(sniffType(base64ToBytes(PNG_BASE64))).toBe('image/png');
    expect(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffType(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
    expect(sniffType(glbBytes())).toBe('model/gltf-binary');
    expect(sniffType(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('data URIs', () => {
  it('encode and decode, sniffing missing types', async () => {
    const uri = await blobToDataUri(new Blob([base64ToBytes(PNG_BASE64) as BlobPart]));
    expect(uri).toBe(`data:image/png;base64,${PNG_BASE64}`);
    const blob = dataUriToBlob(uri)!;
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(base64ToBytes(PNG_BASE64));
    expect(dataUriToBlob('https://example.com/x.png')).toBeNull();
    expect(base64ToBlob(PNG_BASE64).type).toBe('image/png');
    expect((await withSniffedType(new Blob([glbBytes()], { type: 'application/octet-stream' }))).type).toBe('model/gltf-binary');
  });
});

describe('isGlbBuffer', () => {
  it('checks the magic and version', () => {
    expect(isGlbBuffer(glbBytes().buffer)).toBe(true);
    expect(isGlbBuffer(new Uint8Array(12).buffer)).toBe(false);
    expect(isGlbBuffer(new Uint8Array(4).buffer)).toBe(false);
  });
});

describe('toUploadPng', () => {
  it('passes blobs through where no canvas exists (Node)', async () => {
    const b = pngBlob();
    expect(await toUploadPng(b)).toBe(b);
  });
});
