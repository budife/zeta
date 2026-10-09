export type MediaKind = "image" | "video";

const VIDEO_MIME_RE = /^video\//i;
const IMAGE_MIME_RE = /^image\//i;
const VIDEO_EXT_RE = /\.(mp4|webm|ogg|mov)(\?|#|$)/i;

/**
 * Classifies a selected media source for rendering.
 *
 * Asset paths usually carry a file extension, but uploaded files are rendered
 * through `blob:` URLs with no extension. For those, the browser-provided file
 * MIME type is the authoritative signal. Unknown/unsupported values fall back
 * to image rendering because an <img> failure is inert, while a false video
 * classification would create unnecessary playback machinery.
 */
export function mediaKindFromSource(src: string | null, mimeType?: string | null): MediaKind {
  if (mimeType && VIDEO_MIME_RE.test(mimeType)) return "video";
  if (mimeType && IMAGE_MIME_RE.test(mimeType)) return "image";
  return src && VIDEO_EXT_RE.test(src) ? "video" : "image";
}
