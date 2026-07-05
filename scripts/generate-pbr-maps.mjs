// Génère roughnessMap pour le recto et le verso de la pochette — DEUX traitements
// différents, pas une logique partagée, parce que les deux artworks n'ont rien à voir :
//
// RECTO (cover-front.png) : métal gravé argenté imprimé sur toute la surface. Dégradé
// CONTINU dérivé de la luminance : chaque pixel devient son propre niveau de satiné,
// proportionnel à sa propre luminosité (clair -> roughness basse/reflet net, noir ->
// roughness haute/mat total). Voir generateFrontRoughness().
//
// VERSO (cover-back.png) : fond vert mat granuleux + texte noir mat + UN SEUL élément
// brillant (le motif croix/chapelet argenté). La logique de luminance du recto ne
// s'applique pas : le vert est un papier mat coloré, pas une zone "brillante" au sens
// photométrique, donc un simple seuil de luminance capterait le vert à tort. On isole
// donc spécifiquement les pixels à la fois CLAIRS et DÉSATURÉS (le gris/blanc du
// chapelet), en excluant tout pixel saturé (le vert) quelle que soit sa luminosité.
// Tout le reste (vert + noir) reste mat. Voir generateBackRoughness().
//
// Les deux : metalness reste ~0 partout (carton/papier, pas de métal, voir SLEEVE_PBR
// dans src/config/scene.ts) ; le fichier encode l'INVERSE de la valeur "brillance"
// (brillant -> valeur basse, mat -> valeur haute), combiné au mix(roughnessMin,
// roughnessMax, g) appliqué dans Experience.vue (patchRoughnessRemap). Un flou gaussien
// léger reste appliqué pour lisser le bruit photo/scan pixel-à-pixel (grain/sparkle
// spéculaire sous lumière rasante) sans effacer les zones de brillance.
//
// Usage :
//   node scripts/generate-pbr-maps.mjs front [blurSigma]
//   node scripts/generate-pbr-maps.mjs back [luminanceThreshold] [saturationThreshold] [blurSigma]
//
//   (recto) blurSigma : rayon du flou gaussien en pixels. 0 désactive le flou.
//   (verso) luminanceThreshold : 0-255, défaut 60. Augmenter si des zones de la croix
//     un peu sombres sont encore classées mates ; diminuer si des zones mates
//     paraissent encore trop brillantes.
//   (verso) saturationThreshold : 0-1, défaut 0.18. Diminuer si des restes de vert
//     passent à tort en brillant ; augmenter si des zones de la croix sont exclues.
//   (verso) blurSigma : rayon du flou gaussien en pixels, défaut 2.

import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const texturesDir = path.join(__dirname, '..', 'public', 'textures')

async function generateFrontRoughness(blurSigmaArg) {
  const source = path.join(texturesDir, 'cover-front.png')
  const out = path.join(texturesDir, 'cover-roughness.jpg')
  const blurSigma = blurSigmaArg !== undefined ? Number(blurSigmaArg) : 2

  const { data, info } = await sharp(source).removeAlpha().grayscale().raw().toBuffer({ resolveWithObject: true })
  const inverted = Buffer.alloc(data.length)
  for (let i = 0; i < data.length; i++) inverted[i] = 255 - data[i]

  let pipeline = sharp(inverted, { raw: { width: info.width, height: info.height, channels: 1 } })
  if (blurSigma > 0) pipeline = pipeline.blur(blurSigma)
  await pipeline.jpeg({ quality: 95 }).toFile(out)

  console.log('Face: front (dégradé continu, luminance inversée)')
  console.log(`Blur sigma: ${blurSigma}`)
  console.log(`Written: ${out}`)
}

async function generateBackRoughness(luminanceThresholdArg, saturationThresholdArg, blurSigmaArg) {
  const source = path.join(texturesDir, 'cover-back.png')
  const out = path.join(texturesDir, 'cover-back-roughness.jpg')
  const luminanceThreshold = luminanceThresholdArg !== undefined ? Number(luminanceThresholdArg) : 60
  const saturationThreshold = saturationThresholdArg !== undefined ? Number(saturationThresholdArg) : 0.18
  const blurSigma = blurSigmaArg !== undefined ? Number(blurSigmaArg) : 2

  const { data, info } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const out2 = Buffer.alloc(info.width * info.height)
  for (let i = 0; i < out2.length; i++) {
    const r = data[i * 3]
    const g = data[i * 3 + 1]
    const b = data[i * 3 + 2]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const saturation = max === 0 ? 0 : (max - min) / max
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    // Croix/chapelet argenté : clair ET désaturé (gris/blanc). Le vert, bien que
    // parfois clair, est saturé -> exclu. Le texte noir est sombre -> exclu.
    const isCross = saturation < saturationThreshold && luminance >= luminanceThreshold
    out2[i] = isCross ? 0 : 255 // brillant -> valeur basse, mat (vert + noir) -> haute
  }

  let pipeline = sharp(out2, { raw: { width: info.width, height: info.height, channels: 1 } })
  if (blurSigma > 0) pipeline = pipeline.blur(blurSigma)
  await pipeline.jpeg({ quality: 95 }).toFile(out)

  console.log('Face: back (isolation croix/chapelet : clair + désaturé)')
  console.log(`Luminance threshold: ${luminanceThreshold}`)
  console.log(`Saturation threshold: ${saturationThreshold}`)
  console.log(`Blur sigma: ${blurSigma}`)
  console.log(`Written: ${out}`)
}

const face = process.argv[2] || 'front'
if (face === 'front') {
  await generateFrontRoughness(process.argv[3])
} else if (face === 'back') {
  await generateBackRoughness(process.argv[3], process.argv[4], process.argv[5])
} else {
  throw new Error(`Face inconnue: "${face}". Attendu: front | back`)
}
