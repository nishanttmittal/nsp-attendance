/**
 * Phone photo → small JPEG dataURL (browser only) — copied from falcon/src/logic/photo.js (01-10-2026).
 * Target ≤ ~125 KB: long side 900 px at q 0.6, stepping down until it fits.
 */
const LIMIT = 170000 // chars of base64 ≈ 125 KB

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Photo khul nahi rahi')) }
    img.src = url
  })
}

export async function compressPhoto(file) {
  const img = await loadImage(file)
  for (const [side, q] of [[900, 0.6], [800, 0.5], [640, 0.45], [520, 0.4]]) {
    const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale)
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    c.getContext('2d').drawImage(img, 0, 0, w, h)
    const url = c.toDataURL('image/jpeg', q)
    if (url.startsWith('data:image/jpeg;base64,') && url.length < LIMIT) return url
  }
  throw new Error('Photo bahut badi hai, dobara lo')
}
