/**
 * Photo downscaling at the capture boundary (issue #58). A phone camera
 * hands us a 3-8MB JPEG/HEIC original; every current consumer (64px
 * thumbnails, the full-screen viewer, the vision captioner's own 1024px
 * re-encode in `vision/api.ts`) needs far less than that. Downscaling once
 * here — at the moment a photo attachment is built, before it ever reaches
 * `capture`/`amend` — means every replica (local IndexedDB and every other
 * device's pull) stores and syncs the same right-sized blob, with no
 * separate `keepPhotosLocally`/on-demand-pull knob to reason about
 * alongside `keepAudioLocally`, and no multi-GB backlog to retrofit once
 * users already have one (deciding this after the fact is much harder than
 * deciding it once, up front).
 */

/** Long edge of the stored photo — visually lossless at phone-screen sizes. */
export const MAX_PHOTO_EDGE_PX = 2048
const JPEG_QUALITY = 0.85

/**
 * Pure: target dimensions preserving aspect ratio, capped so the long edge
 * never exceeds `maxEdge`. Never upscales (a source already under the cap
 * keeps its exact size). Always yields at least 1x1.
 */
export function scaledDimensions(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export interface DownscaledPhoto {
  blob: Blob
  mimeType: string
}

/**
 * Downscale + re-encode a captured photo to JPEG (long edge
 * `MAX_PHOTO_EDGE_PX`, quality 0.85). `imageOrientation: 'from-image'` bakes
 * EXIF rotation into the re-encoded pixels so an EXIF-rotated portrait
 * doesn't land sideways (the same latent concern noted on the captioner's
 * own canvas path). Falls back to the original blob, untouched, on any
 * decode/encode failure (exotic formats, no canvas context, browsers that
 * refuse `createImageBitmap` on HEIC) — a bigger original beats a lost
 * photo. Not unit-tested directly: `createImageBitmap`/`canvas` are browser
 * APIs unavailable under the project's node test environment, matching the
 * untested precedent of `vision/api.ts#toJpegBase64`'s identical canvas
 * path. `scaledDimensions` above carries the tested logic.
 */
export async function downscalePhoto(blob: Blob): Promise<DownscaledPhoto> {
  const fallback: DownscaledPhoto = { blob, mimeType: blob.type || 'image/jpeg' }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch {
    return fallback
  }
  try {
    const { width, height } = scaledDimensions(bitmap.width, bitmap.height, MAX_PHOTO_EDGE_PX)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return fallback
    ctx.drawImage(bitmap, 0, 0, width, height)
    const jpeg = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    )
    return jpeg ? { blob: jpeg, mimeType: 'image/jpeg' } : fallback
  } catch {
    return fallback
  } finally {
    bitmap.close()
  }
}
