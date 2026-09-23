// Local recognition and remote page storage must accept the same original image.
// This is a per-file limit, not a limit on the total size of an imported batch.
export const MAX_SCAN_IMAGE_BYTES = 50 * 1024 * 1024;
