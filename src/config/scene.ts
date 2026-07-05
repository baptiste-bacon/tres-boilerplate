// Dimensions d'une pochette de vinyle 12" (31.4cm x 31.4cm x 0.6cm), en mètres
export const VINYL_SLEEVE_SIZE = 0.314
export const VINYL_SLEEVE_DEPTH = 0.006

// Caméra parfaitement de face (la pochette regarde +Z, X=0 : aucun décalage latéral).
// Y quasi nul pour ne pas regarder par-dessus. La box elle-même n'a pas de rotation ;
// le grab (useGrabRotation) reste le seul moyen de la voir sous un autre angle.
export const CAMERA_POSITION: [number, number, number] = [0, 0, 0.5]
export const CAMERA_FOV = 45

export const COLORS = {
  background: '#0e0e10',
  sleeveEdge: '#1a1a1a',
  ambientLight: '#ffffff',
  directionalLight: '#ffffff',
} as const

// Chemins par face : recto et verso déclarés séparément, avec leurs propres maps.
// Pas de metalnessMap : la pochette est en carton/papier imprimé mat (voir
// SLEEVE_PBR), le contraste de brillance par zones se joue uniquement sur roughness.
//
// Recto et verso ont des artworks complètement différents et utilisent DEUX
// traitements différents dans scripts/generate-pbr-maps.mjs (pas de logique
// partagée) :
// - Recto (métal gravé imprimé sur toute la surface) : dégradé continu dérivé de la
//   luminance -> chaque pixel a son propre niveau de satiné (clair = plus brillant).
// - Verso (fond vert mat + texte noir mat + un seul motif croix/chapelet argenté) :
//   isolation ciblée des pixels clairs ET désaturés (le gris/blanc du chapelet), en
//   excluant le vert (saturé) et le texte noir (sombre) qui doivent rester mats. Un
//   simple seuil de luminance capterait le vert à tort puisqu'il n'est pas forcément
//   sombre, juste coloré.
export const TEXTURE_PATHS = {
  coverFront: {
    map: '/textures/cover-front.png',
    normalMap: '/textures/front_normal_map_soft.png',
    roughnessMap: '/textures/cover-roughness.jpg',
  },
  coverBack: {
    map: '/textures/cover-back.png',
    normalMap: '/textures/back_normal.png',
    roughnessMap: '/textures/cover-back-roughness.jpg',
  },
} as const

// Intensité du relief (normal map) sur les faces recto/verso. Ajustable en direct
// via le panneau lil-gui (Relief debug).
export const SLEEVE_RELIEF = {
  normalScale: [1, 1] as [number, number],
} as const

// Valeurs de base du matériau, communes aux deux faces (recto/verso restent
// ajustables indépendamment via GUI, mais partent du même point).
//
// metalness=1 (testé contre 0, voir ci-dessous) : la pochette reste conceptuellement
// du CARTON IMPRIMÉ, mais avec l'ambiante et l'envMap réduites à ~0 (voir plus bas),
// la scène n'a quasiment plus de lumière de remplissage — seulement les deux
// directionnelles. Un diélectrique (metalness=0) répond à cette lumière par un
// diffus doux et étalé, qui a besoin d'ambiante/GI pour "remplir" les tons moyens :
// sans ça, testé côte à côte, le rendu est visiblement plus pâle/plus terne (le vert
// du verso délave, les reflets du chapelet s'aplatissent). En metalness=1, toute la
// réponse passe par le spéculaire (teinté par color/map, pas de diffus), qui reste
// concentré et contrasté même sans remplissage. Choix esthétique assumé (pas un
// argument de fidélité physique au carton) pour matcher cet éclairage très écrêté.
// color en blanc pur (pas gris) : color multiplie directement les couleurs de map
// (teinte du spéculaire en metalness=1 ou de l'albedo diffus en metalness=0) — un
// gris aurait juste terni l'artwork imprimé sans raison.
// envMapIntensity=0 : pas de reflet du décor d'environnement.
const PBR_COMMON = {
  metalness: 1,
  envMapIntensity: 0,
  color: '#ffffff',
} as const

export const SLEEVE_PBR = {
  front: { ...PBR_COMMON },
  back: { ...PBR_COMMON },
} as const

// Bornes de roughness par zone, remappées depuis roughnessMap via un patch de shader
// (onBeforeCompile, voir Experience.vue) : roughnessFactor = mix(min, max, map.g) au
// lieu du mix multiplicatif standard de three.js (roughness *= map.g), qui ne permet
// pas de fixer un plancher non nul pour les zones satinées (map.g=0 y donnerait
// toujours roughness=0, un miroir pur, quel que soit le scalaire roughness).
// max=1 = zones mates de l'artwork (map.g≈1) -> parfaitement mates.
// min=0 = zones brillantes (map.g≈0) -> reflet net et marqué.
// Entrées distinctes par face (pas de valeurs partagées) : recto et verso ont des
// artworks différents, chacun garde ses propres bornes ajustables indépendamment
// dans le GUI.
export const SLEEVE_ROUGHNESS_RANGE = {
  front: { min: 0, max: 1 },
  back: { min: 0, max: 1 },
} as const

// HDRI d'environnement : gardée montée même si envMapIntensity=0 par défaut (voir
// SLEEVE_PBR), pour pouvoir remonter le reflet via le seul slider GUI sans re-câbler
// le composant. Multiplicateur global (scene.environmentIntensity, indépendant
// d'envMapIntensity par matériau) à 0 pour la même raison.
export const ENVIRONMENT_PRESET = 'studio'
export const ENVIRONMENT_INTENSITY = 0

// Ambiante à 0 : c'est elle qui "débouche" les ombres et tue le contraste. Éclairage
// 3 points, seule source de lumière de la scène (aucune lumière en face : ça aplatit
// le relief) :
// - KEY (dominante), de côté et légèrement en hauteur, angle rasant : sculpte le
//   relief (gravure de l'artwork + normal map) par l'ombre. Référence des deux autres.
// - FILL (appoint), du côté OPPOSÉ à la key et faible : évite que les ombres du côté
//   opposé tombent à un noir total, sans manger le contraste que la key installe.
// - RIM (contour), derrière-côté (Z négatif) : accroche un liseré lumineux sur les
//   bords pour détacher la pochette du fond noir ("émerge des ténèbres"). Doit
//   scintiller le contour sans éclairer le centre.
// Les trois : intensité + position réglables dans le GUI (voir Experience.vue).
export const AMBIENT_LIGHT_INTENSITY = 0
export const KEY_LIGHT_INTENSITY = 8
export const KEY_LIGHT_POSITION: [number, number, number] = [1, 0, 0.8]
export const FILL_LIGHT_INTENSITY = 2
export const FILL_LIGHT_POSITION: [number, number, number] = [-1, 0, 0.5]
export const RIM_LIGHT_INTENSITY = 3
export const RIM_LIGHT_POSITION: [number, number, number] = [0.5, 0.3, -1]

// Presets key/fill à comparer pour trancher symétrique vs modelé du relief (voir
// sélecteur GUI dans Experience.vue). Ne touchent que les deux intensités : positions,
// rim et ambient restent celles ci-dessus dans tous les cas.
export const LIGHTING_PRESETS = {
  'A - Asymétrique fort': { key: 8, fill: 2 },
  'B - Asymétrique doux': { key: 8, fill: 4 },
  'C - Symétrique': { key: 5, fill: 5 },
} as const

// Rotation "grab" de la pochette (souris + tactile, avec inertie). Voir
// src/composables/useGrabRotation.ts. Remplace la rotation auto : les deux en même
// temps se battraient pour le contrôle de rotation.y.
export const GRAB_ROTATION = {
  sensitivity: 0.01, // radians par pixel de drag
  damping: 0.95, // vélocité *= damping à chaque frame rendue pendant l'inertie
  constrainToYAxis: false, // mode présentoir : ignore le drag vertical
  // Clamp doux (résistance progressive, jamais de mur net) sur la bascule avant/arrière
  // (axe X local) : évite les retournements tête en bas. Toggle + limite réglables.
  verticalClampEnabled: true,
  verticalClampLimitDeg: 60, // ±60°
  // Snap au relâchement sur la face recto/verso la plus proche (ou celle visée par le
  // lancer si la vélocité dépasse le seuil), pitch remis à plat. Toggle + réglages.
  snapEnabled: true,
  snapVelocityThreshold: 1.5, // rad/s : au-delà, la face cible suit la direction du lancer
  snapDuration: 0.45, // secondes, slerp ease-out
} as const

// Tilt passif au survol (voir src/composables/useMouseTilt.ts) : penche la pochette
// vers le curseur, avec un léger retard élastique (lerp). Coupé pendant un grab actif
// (voir Experience.vue) pour ne pas se battre avec useGrabRotation — appliqué comme
// rotation LOCALE sur le mesh, pendant que le grab pilote son groupe parent.
export const MOUSE_TILT = {
  maxAngleDeg: 10, // amplitude max, en degrés (quelques degrés, pas une rotation franche)
  smoothing: 0.1, // lerp par frame vers la cible : bas = mou/élastique, haut = nerveux
} as const
