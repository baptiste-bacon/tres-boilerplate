<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { Environment, OrbitControls, Grid, Stats, useTexture } from '@tresjs/cientos'
import { useLoop, useTres } from '@tresjs/core'
import { SRGBColorSpace, type DirectionalLight, type Group, type Mesh, type MeshStandardMaterial } from 'three'
import GUI from 'lil-gui'
import { useGrabRotation } from '../composables/useGrabRotation'
import { useHoverCursor } from '../composables/useHoverCursor'
import { useLightHelpers } from '../composables/useLightHelpers'
import { useMouseTilt } from '../composables/useMouseTilt'
import {
  VINYL_SLEEVE_SIZE,
  VINYL_SLEEVE_DEPTH,
  TEXTURE_PATHS,
  SLEEVE_RELIEF,
  SLEEVE_PBR,
  SLEEVE_ROUGHNESS_RANGE,
  ENVIRONMENT_PRESET,
  ENVIRONMENT_INTENSITY,
  COLORS,
  AMBIENT_LIGHT_INTENSITY,
  KEY_LIGHT_INTENSITY,
  KEY_LIGHT_POSITION,
  FILL_LIGHT_INTENSITY,
  FILL_LIGHT_POSITION,
  RIM_LIGHT_INTENSITY,
  RIM_LIGHT_POSITION,
  LIGHTING_PRESETS,
  GRAB_ROTATION,
  MOUSE_TILT,
} from '../config/scene'

// Remplace le mix multiplicatif standard de three.js pour roughnessMap
// (roughnessFactor *= texelRoughness.g) par un mix(min, max, g) : la version standard
// ne permet pas de fixer un plancher non nul pour les zones où map.g=0 (toujours
// roughness=0 = miroir pur, quel que soit le scalaire roughness). Voir
// SLEEVE_ROUGHNESS_RANGE dans src/config/scene.ts pour le contexte.
function patchRoughnessRemap(material: MeshStandardMaterial, range: { min: { value: number }; max: { value: number } }) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRoughnessMin = range.min
    shader.uniforms.uRoughnessMax = range.max
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <roughnessmap_pars_fragment>',
        '#include <roughnessmap_pars_fragment>\nuniform float uRoughnessMin;\nuniform float uRoughnessMax;',
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
  roughnessFactor = mix( uRoughnessMin, uRoughnessMax, texelRoughness.g );
#endif`,
      )
  }
  material.needsUpdate = true
}

const showGrid = ref(false)
const showAxes = ref(false)

// grabPivotRef (groupe parent) porte la rotation accumulée du grab ; sleeveRef (mesh
// enfant) porte uniquement le tilt (rotation locale, jamais accumulée). Les deux
// composent naturellement via la hiérarchie de scène, sans se corrompre : le grab
// n'a besoin de rien savoir du tilt, et inversement.
const grabPivotRef = ref<Group>()
const sleeveRef = ref<Mesh>()

// Rotation au grab (souris + tactile, inertie) : remplace la rotation auto, les deux
// se battraient pour le contrôle de rotation.y/x. OrbitControls garde le zoom/pan
// mais sa propre rotation est désactivée plus bas (même raison).
const debugGrab = reactive({
  sensitivity: GRAB_ROTATION.sensitivity,
  damping: GRAB_ROTATION.damping,
  constrainToYAxis: GRAB_ROTATION.constrainToYAxis,
  verticalClampEnabled: GRAB_ROTATION.verticalClampEnabled,
  verticalClampLimitDeg: GRAB_ROTATION.verticalClampLimitDeg,
  snapEnabled: GRAB_ROTATION.snapEnabled,
  snapVelocityThreshold: GRAB_ROTATION.snapVelocityThreshold,
  snapDuration: GRAB_ROTATION.snapDuration,
})
const grab = useGrabRotation(grabPivotRef, {
  sensitivity: computed(() => debugGrab.sensitivity),
  damping: computed(() => debugGrab.damping),
  constrainToYAxis: computed(() => debugGrab.constrainToYAxis),
  verticalClampLimit: computed(() => (debugGrab.verticalClampEnabled ? (debugGrab.verticalClampLimitDeg * Math.PI) / 180 : null)),
  snapEnabled: computed(() => debugGrab.snapEnabled),
  snapVelocityThreshold: computed(() => debugGrab.snapVelocityThreshold),
  snapDuration: computed(() => debugGrab.snapDuration),
})

// Feedback curseur (grab/grabbing/défaut) sur le survol du mesh de la pochette (voir
// useHoverCursor pour la logique et les priorités). isActive = isDragging seulement
// (pas isSnapping) : pendant l'animation de snap post-relâchement, on ne tient plus
// rien, le curseur ne doit donc pas rester bloqué sur "grabbing".
const hoverCursor = useHoverCursor({ isActive: grab.isDragging })

// Tilt passif au survol (voir useMouseTilt) : coupé pendant un grab actif, tant que son
// inertie tourne encore (vélocité pas totalement retombée à 0), ou pendant le snap de
// relâchement, pour ne pas se battre avec le grab ni donner l'impression que la
// pochette "vibre" entre les deux. Reprend la main en douceur une fois le snap terminé
// et la pochette stabilisée à plat sur sa face (la cible du tilt revient à la position
// de la souris, le lerp fait le reste).
const debugTilt = reactive({
  maxAngleDeg: MOUSE_TILT.maxAngleDeg,
  smoothing: MOUSE_TILT.smoothing,
})
const tiltEnabled = computed(
  () => !grab.isDragging.value && !grab.isSnapping.value && grab.velocity.x === 0 && grab.velocity.y === 0,
)
useMouseTilt(sleeveRef, {
  maxAngle: computed(() => (debugTilt.maxAngleDeg * Math.PI) / 180),
  smoothing: computed(() => debugTilt.smoothing),
  enabled: tiltEnabled,
})

const frontMaterialRef = ref<MeshStandardMaterial>()
const backMaterialRef = ref<MeshStandardMaterial>()
const { scene } = useTres()

// <Environment> charge l'HDRI de façon async et l'assigne à scene.environment. En
// théorie MeshStandardMaterial retombe sur scene.environment quand material.envMap
// est null, mais ce fallback implicite ne s'est PAS avéré fiable ici (vérifié : même
// après needsUpdate=true, envMapIntensity de 0 à 50 ne changeait STRICTEMENT rien au
// rendu - diff de pixels nul). On assigne donc envMap explicitement sur chaque
// matériau dès que l'environment est prêt, ce qui, lui, fonctionne (vérifié par diff
// de pixels non nul).
//
// Un watch() sur scene.value?.environment ne suffit pas pour détecter ce moment :
// useTres().scene est un ShallowRef, qui ne suit pas les mutations de propriétés
// internes (Environment fait scene.value.environment = texture, une mutation, pas une
// réassignation de .value). On poll donc une fois par frame via la boucle de rendu
// (qui tourne de toute façon en continu ici) jusqu'à ce que l'environment apparaisse.
let envMapApplied = false
const { onBeforeRender } = useLoop()
onBeforeRender(() => {
  if (envMapApplied) return
  const environment = scene.value?.environment
  if (!environment) return
  envMapApplied = true
  if (frontMaterialRef.value) {
    frontMaterialRef.value.envMap = environment
    frontMaterialRef.value.needsUpdate = true
  }
  if (backMaterialRef.value) {
    backMaterialRef.value.envMap = environment
    backMaterialRef.value.needsUpdate = true
  }
})

// DEBUG TEMPORAIRE : confirme que l'envMap est bien active après la recompilation.
onMounted(() => {
  setTimeout(() => {
    console.log('[envmap] scene.environment', scene.value?.environment)
    console.log('[envmap] front material.envMap', frontMaterialRef.value?.envMap, 'envMapIntensity', frontMaterialRef.value?.envMapIntensity)
    console.log('[envmap] back material.envMap', backMaterialRef.value?.envMap, 'envMapIntensity', backMaterialRef.value?.envMapIntensity)
  }, 2000)
})

// Uniforms du patch roughness min/max (voir patchRoughnessRemap ci-dessus), mis à
// jour depuis le GUI à chaque frame plus bas. Objets stables réutilisés à chaque
// (re)compilation du shader, pour que les mises à jour restent valides après un
// éventuel needsUpdate (ex. quand envMap s'active).
const frontRoughnessRange = {
  min: { value: SLEEVE_ROUGHNESS_RANGE.front.min },
  max: { value: SLEEVE_ROUGHNESS_RANGE.front.max },
}
const backRoughnessRange = {
  min: { value: SLEEVE_ROUGHNESS_RANGE.back.min },
  max: { value: SLEEVE_ROUGHNESS_RANGE.back.max },
}
onMounted(() => {
  if (frontMaterialRef.value) patchRoughnessRemap(frontMaterialRef.value, frontRoughnessRange)
  if (backMaterialRef.value) patchRoughnessRemap(backMaterialRef.value, backRoughnessRange)
})

// Couleur (sRGB) : une map par face.
const { state: coverFrontMap, error: coverFrontMapError } = useTexture(TEXTURE_PATHS.coverFront.map)
const { state: coverBackMap, error: coverBackMapError } = useTexture(TEXTURE_PATHS.coverBack.map)
watch(coverFrontMap, (texture) => {
  if (texture) texture.colorSpace = SRGBColorSpace
})
watch(coverBackMap, (texture) => {
  if (texture) texture.colorSpace = SRGBColorSpace
})

// Relief (normal map) : donnée, pas de couleur -> pas de SRGBColorSpace (reste au
// colorSpace par défaut de useTexture, linéaire/NoColorSpace).
const { state: coverFrontNormal, error: coverFrontNormalError } = useTexture(TEXTURE_PATHS.coverFront.normalMap)
const { state: coverBackNormal, error: coverBackNormalError } = useTexture(TEXTURE_PATHS.coverBack.normalMap)

// roughnessMap (contraste mat/satiné par zones) : donnée, pas de couleur -> pas de
// SRGBColorSpace.
const { state: coverFrontRoughness } = useTexture(TEXTURE_PATHS.coverFront.roughnessMap)
const { state: coverBackRoughness } = useTexture(TEXTURE_PATHS.coverBack.roughnessMap)

// DEBUG TEMPORAIRE : confirme le chargement (pas de 404) et le colorSpace de
// chaque texture. À retirer une fois le relief validé.
watch([coverFrontMap, coverBackMap, coverFrontNormal, coverBackNormal], () => {
  console.log('[textures] cover-front map', TEXTURE_PATHS.coverFront.map, coverFrontMap.value, 'error:', coverFrontMapError.value)
  console.log('[textures] cover-back map', TEXTURE_PATHS.coverBack.map, coverBackMap.value, 'error:', coverBackMapError.value)
  console.log(
    '[textures] front normalMap',
    TEXTURE_PATHS.coverFront.normalMap,
    coverFrontNormal.value,
    'colorSpace:',
    coverFrontNormal.value?.colorSpace,
    'error:',
    coverFrontNormalError.value,
  )
  console.log(
    '[textures] back normalMap',
    TEXTURE_PATHS.coverBack.normalMap,
    coverBackNormal.value,
    'colorSpace:',
    coverBackNormal.value?.colorSpace,
    'error:',
    coverBackNormalError.value,
  )
})

// DEBUG TEMPORAIRE : panneau lil-gui pour ajuster l'éclairage 3 points en direct.
// À retirer une fois les réglages validés.
// KEY : dominante, de côté et légèrement en hauteur, angle rasant. Sculpte le relief
// (gravure de l'artwork + normal map) par l'ombre. Référence des deux autres lumières.
const debugKeyLight = reactive({
  intensity: KEY_LIGHT_INTENSITY,
  x: KEY_LIGHT_POSITION[0],
  y: KEY_LIGHT_POSITION[1],
  z: KEY_LIGHT_POSITION[2],
})
// FILL : du côté OPPOSÉ à la key, faible. Évite que les ombres du côté opposé
// tombent à un noir total, sans manger le contraste installé par la key.
const debugFillLight = reactive({
  intensity: FILL_LIGHT_INTENSITY,
  x: FILL_LIGHT_POSITION[0],
  y: FILL_LIGHT_POSITION[1],
  z: FILL_LIGHT_POSITION[2],
})
// RIM : derrière-côté (Z négatif), accroche un liseré lumineux sur les bords pour
// détacher la pochette du fond noir ("émerge des ténèbres"). Doit scintiller le
// contour sans éclairer le centre.
const debugRimLight = reactive({
  intensity: RIM_LIGHT_INTENSITY,
  x: RIM_LIGHT_POSITION[0],
  y: RIM_LIGHT_POSITION[1],
  z: RIM_LIGHT_POSITION[2],
})
// Presets key/fill à comparer (symétrique vs modelé du relief) : ne touchent que les
// deux intensités, tout le reste (positions, rim, ambient) reste identique. Choisir un
// preset dans le GUI n'empêche pas de continuer à affiner key/fill à la main ensuite.
const presetNames = Object.keys(LIGHTING_PRESETS) as Array<keyof typeof LIGHTING_PRESETS>
const debugPreset = reactive({
  name: presetNames[0],
})
function applyLightingPreset(name: keyof typeof LIGHTING_PRESETS) {
  const preset = LIGHTING_PRESETS[name]
  debugKeyLight.intensity = preset.key
  debugFillLight.intensity = preset.fill
}

// Helpers visuels (position + direction) pour les 3 lumières, outil de dev pur : voir
// useLightHelpers. Désactivés par défaut, un seul toggle pour les 3 d'un coup.
// Couleurs distinctes pour identifier key/fill/rim d'un coup d'œil.
const keyLightRef = ref<DirectionalLight>()
const fillLightRef = ref<DirectionalLight>()
const rimLightRef = ref<DirectionalLight>()
const debugHelpers = reactive({ visible: false })
useLightHelpers(
  [
    { light: keyLightRef, color: 0xffaa00, size: 0.15 },
    { light: fillLightRef, color: 0x00aaff, size: 0.15 },
    { light: rimLightRef, color: 0xff00ff, size: 0.15 },
  ],
  computed(() => debugHelpers.visible),
)
// Ambient + environmentIntensity : c'est ce qui débouche les ombres/uniformise le
// rendu. Point de départ sombre, à affiner à l'œil (voir SLEEVE_PBR pour le contexte).
const debugAmbient = reactive({
  intensity: AMBIENT_LIGHT_INTENSITY,
})
const debugEnvironment = reactive({
  environmentIntensity: ENVIRONMENT_INTENSITY,
})
const debugRelief = reactive({
  normalScaleX: SLEEVE_RELIEF.normalScale[0],
  normalScaleY: SLEEVE_RELIEF.normalScale[1],
})
const debugPbrFront = reactive({
  metalness: SLEEVE_PBR.front.metalness,
  roughnessMin: SLEEVE_ROUGHNESS_RANGE.front.min,
  roughnessMax: SLEEVE_ROUGHNESS_RANGE.front.max,
  envMapIntensity: SLEEVE_PBR.front.envMapIntensity,
  color: SLEEVE_PBR.front.color,
})
const debugPbrBack = reactive({
  metalness: SLEEVE_PBR.back.metalness,
  roughnessMin: SLEEVE_ROUGHNESS_RANGE.back.min,
  roughnessMax: SLEEVE_ROUGHNESS_RANGE.back.max,
  envMapIntensity: SLEEVE_PBR.back.envMapIntensity,
  color: SLEEVE_PBR.back.color,
})
// Synchro GUI -> uniforms du patch shader, chaque frame (coût négligeable, évite un
// watch() par champ).
onBeforeRender(() => {
  frontRoughnessRange.min.value = debugPbrFront.roughnessMin
  frontRoughnessRange.max.value = debugPbrFront.roughnessMax
  backRoughnessRange.min.value = debugPbrBack.roughnessMin
  backRoughnessRange.max.value = debugPbrBack.roughnessMax
})
const debugKeyLightPosition = computed<[number, number, number]>(() => [debugKeyLight.x, debugKeyLight.y, debugKeyLight.z])
const debugFillLightPosition = computed<[number, number, number]>(() => [debugFillLight.x, debugFillLight.y, debugFillLight.z])
const debugRimLightPosition = computed<[number, number, number]>(() => [debugRimLight.x, debugRimLight.y, debugRimLight.z])
const debugNormalScale = computed<[number, number]>(() => [debugRelief.normalScaleX, debugRelief.normalScaleY])

// DEBUG TEMPORAIRE : expose pour test Playwright. À retirer.
;(window as any).__debug = { debugPbrFront, debugPbrBack, debugRelief, debugAmbient, debugEnvironment, debugKeyLight, debugFillLight, debugRimLight, debugPreset, applyLightingPreset, debugHelpers, keyLightRef, fillLightRef, rimLightRef, frontMaterialRef, backMaterialRef, sleeveRef, grabPivotRef, grab, debugGrab, debugTilt, tiltEnabled, hoverCursor, scene }

onMounted(() => {
  const gui = new GUI({ title: 'Relief debug' })
  const grabFolder = gui.addFolder('Grab rotation')
  grabFolder.add(debugGrab, 'sensitivity', 0.001, 0.05, 0.001)
  grabFolder.add(debugGrab, 'damping', 0.8, 0.995, 0.001)
  grabFolder.add(debugGrab, 'constrainToYAxis').name('Y axis only (présentoir)')
  const clampFolder = grabFolder.addFolder('Clamp vertical')
  clampFolder.add(debugGrab, 'verticalClampEnabled').name('activé')
  clampFolder.add(debugGrab, 'verticalClampLimitDeg', 10, 90, 1).name('limite (°)')
  const snapFolder = grabFolder.addFolder('Snap recto/verso')
  snapFolder.add(debugGrab, 'snapEnabled').name('activé')
  snapFolder.add(debugGrab, 'snapVelocityThreshold', 0.1, 6, 0.1).name('seuil vélocité (rad/s)')
  snapFolder.add(debugGrab, 'snapDuration', 0.1, 1.5, 0.05).name('durée (s)')
  const tiltFolder = gui.addFolder('Mouse tilt (survol)')
  tiltFolder.add(debugTilt, 'maxAngleDeg', 0, 20, 0.5).name('amplitude (°)')
  tiltFolder.add(debugTilt, 'smoothing', 0.01, 0.5, 0.01).name('lissage (lerp)')
  const reliefFolder = gui.addFolder('Relief (normal map)')
  reliefFolder.add(debugRelief, 'normalScaleX', -3, 3, 0.05).name('normalScale.x')
  reliefFolder.add(debugRelief, 'normalScaleY', -3, 3, 0.05).name('normalScale.y')
  const pbrFrontFolder = gui.addFolder('Recto matériau (carton imprimé)')
  pbrFrontFolder.add(debugPbrFront, 'metalness', 0, 1, 0.01)
  pbrFrontFolder.add(debugPbrFront, 'roughnessMin', 0, 1, 0.01).name('roughness min (zones argentées)')
  pbrFrontFolder.add(debugPbrFront, 'roughnessMax', 0, 1, 0.01).name('roughness max (zones noires)')
  pbrFrontFolder.add(debugPbrFront, 'envMapIntensity', 0, 5, 0.05)
  pbrFrontFolder.addColor(debugPbrFront, 'color')
  const pbrBackFolder = gui.addFolder('Verso matériau (carton imprimé)')
  pbrBackFolder.add(debugPbrBack, 'metalness', 0, 1, 0.01)
  pbrBackFolder.add(debugPbrBack, 'roughnessMin', 0, 1, 0.01).name('roughness min (zones argentées)')
  pbrBackFolder.add(debugPbrBack, 'roughnessMax', 0, 1, 0.01).name('roughness max (zones noires)')
  pbrBackFolder.add(debugPbrBack, 'envMapIntensity', 0, 5, 0.05)
  pbrBackFolder.addColor(debugPbrBack, 'color')
  const lightingFolder = gui.addFolder('Ambiance globale (contraste)')
  lightingFolder.add(debugAmbient, 'intensity', 0, 1, 0.01).name('ambient intensity')
  lightingFolder.add(debugEnvironment, 'environmentIntensity', 0, 2, 0.01).name('HDRI intensity (globale)')
  gui
    .add(debugPreset, 'name', presetNames)
    .name('Preset key/fill')
    .onChange((name: keyof typeof LIGHTING_PRESETS) => applyLightingPreset(name))
  gui.add(debugHelpers, 'visible').name('Show light helpers')
  const keyLightFolder = gui.addFolder('Key light (dominante)')
  keyLightFolder.add(debugKeyLight, 'intensity', 0, 12, 0.1)
  keyLightFolder.add(debugKeyLight, 'x', -3, 3, 0.05)
  keyLightFolder.add(debugKeyLight, 'y', -3, 3, 0.05)
  keyLightFolder.add(debugKeyLight, 'z', -3, 3, 0.05)
  const fillLightFolder = gui.addFolder('Fill light (appoint, côté opposé)')
  fillLightFolder.add(debugFillLight, 'intensity', 0, 8, 0.1)
  fillLightFolder.add(debugFillLight, 'x', -3, 3, 0.05)
  fillLightFolder.add(debugFillLight, 'y', -3, 3, 0.05)
  fillLightFolder.add(debugFillLight, 'z', -3, 3, 0.05)
  const rimLightFolder = gui.addFolder('Rim light (contour, derrière)')
  rimLightFolder.add(debugRimLight, 'intensity', 0, 8, 0.1)
  rimLightFolder.add(debugRimLight, 'x', -3, 3, 0.05)
  rimLightFolder.add(debugRimLight, 'y', -3, 3, 0.05)
  rimLightFolder.add(debugRimLight, 'z', -3, 3, 0.05)
})
</script>

<template>
  <!-- Volontairement à 0 : une ambiante débouche les ombres et tue le contraste
       dramatique recherché ("la pochette émerge du noir"). -->
  <TresAmbientLight :color="COLORS.ambientLight" :intensity="debugAmbient.intensity" />
  <!-- KEY : dominante, de côté et légèrement en hauteur, angle rasant. Sculpte le
       relief (gravure + normal map) par l'ombre. Référence des deux autres lumières :
       fill et rim se règlent en ratio par rapport à elle. -->
  <TresDirectionalLight
    ref="keyLightRef"
    :color="COLORS.directionalLight"
    :intensity="debugKeyLight.intensity"
    :position="debugKeyLightPosition"
  />
  <!-- FILL : côté OPPOSÉ à la key (x négatif), faible. Évite que les ombres du côté
       opposé tombent à un noir total, sans manger le contraste de la key. -->
  <TresDirectionalLight
    ref="fillLightRef"
    :color="COLORS.directionalLight"
    :intensity="debugFillLight.intensity"
    :position="debugFillLightPosition"
  />
  <!-- RIM : derrière-côté (Z négatif). Accroche un liseré lumineux sur les bords pour
       détacher la pochette du fond noir ("émerge des ténèbres"), sans éclairer le
       centre. -->
  <TresDirectionalLight
    ref="rimLightRef"
    :color="COLORS.directionalLight"
    :intensity="debugRimLight.intensity"
    :position="debugRimLightPosition"
  />
  <!-- envMapIntensity par défaut à 0 (carton mat, ne reflète pas le décor) mais
       Environment reste montée pour garder le slider fonctionnel sans re-câblage.
       Suspense : Environment charge l'HDRI de façon asynchrone (setup async). -->
  <Suspense>
    <Environment :preset="ENVIRONMENT_PRESET" :environment-intensity="debugEnvironment.environmentIntensity" />
  </Suspense>

  <!-- grabPivotRef porte la rotation accumulée du grab ; sleeveRef (mesh) porte le
       tilt au survol, comme rotation locale sur ce même mesh. Composition naturelle
       via la hiérarchie de scène, aucune des deux logiques ne touche l'état de l'autre. -->
  <TresGroup ref="grabPivotRef">
    <!-- Pochette de vinyle : BoxGeometry, faces trouées dans l'ordre three.js [+X, -X, +Y, -Y, +Z, -Z].
         Cible du grab et du feedback curseur (voir useGrabRotation.startGrab et
         useHoverCursor) : raycasting géré nativement par TresJS via ces events, pas de
         raycaster manuel. Un pointer-down ailleurs sur le canvas (le vide) n'atteint
         jamais ce mesh et ne déclenche donc aucune rotation. -->
    <!-- Pas de tiret dans ces noms d'event (@pointerenter, pas @pointer-enter) :
         TresJS attend les clés de prop exactes onPointerenter/onPointerleave/onPointerdown
         (suffixe tout en minuscules), alors que la forme à tiret serait camelCasée par
         Vue en onPointerEnter/onPointerDown et ne matcherait pas -> aucun event ne
         partirait, silencieusement. -->
    <TresMesh
      ref="sleeveRef"
      @pointerenter="hoverCursor.onPointerEnter"
      @pointerleave="hoverCursor.onPointerLeave"
      @pointerdown="grab.startGrab"
    >
      <TresBoxGeometry :args="[VINYL_SLEEVE_SIZE, VINYL_SLEEVE_SIZE, VINYL_SLEEVE_DEPTH]" />
      <TresMeshStandardMaterial attach="material-0" :color="COLORS.sleeveEdge" />
      <TresMeshStandardMaterial attach="material-1" :color="COLORS.sleeveEdge" />
      <TresMeshStandardMaterial attach="material-2" :color="COLORS.sleeveEdge" />
      <TresMeshStandardMaterial attach="material-3" :color="COLORS.sleeveEdge" />
      <!--
        Face 4 (+Z, avant/recto). Carton imprimé mat, pas du métal : l'artwork (map)
        REPRÉSENTE un métal gravé mais c'est une illusion portée entièrement par
        l'image imprimée, pas par les propriétés physiques du matériau (metalness quasi
        nul, voir SLEEVE_PBR dans src/config/scene.ts). Contraste mat/satiné par zones
        piloté par roughnessMap + patchRoughnessRemap (mix roughnessMin/Max, voir plus
        haut) : PAS de metalness par zones. normalScale/metalness/envMapIntensity
        ajustables sans toucher au code.
        Pas de bumpMap : pas de height map réelle pour l'instant, le relief vient
        uniquement de la normal map. Une vraie height map utilisée en displacement
        (au lieu de bump) nécessiterait de subdiviser la BoxGeometry, ce qu'on évite ici.
      -->
      <TresMeshStandardMaterial
        ref="frontMaterialRef"
        attach="material-4"
        :map="coverFrontMap"
        :normal-map="coverFrontNormal"
        :normal-scale="debugNormalScale"
        :roughness-map="coverFrontRoughness"
        :metalness="debugPbrFront.metalness"
        :env-map-intensity="debugPbrFront.envMapIntensity"
        :color="debugPbrFront.color"
      />
      <!--
        Face 5 (-Z, arrière/verso) : regarde vers -Z, donc la texture apparaît en
        miroir horizontal quand on retourne la pochette. Si le verso doit être
        inversé pour matcher l'artwork réel : coverBackMap.wrapS = RepeatWrapping
        et coverBackMap.repeat.x = -1 (non activé par défaut, à juger visuellement).
      -->
      <TresMeshStandardMaterial
        ref="backMaterialRef"
        attach="material-5"
        :map="coverBackMap"
        :normal-map="coverBackNormal"
        :normal-scale="debugNormalScale"
        :roughness-map="coverBackRoughness"
        :metalness="debugPbrBack.metalness"
        :env-map-intensity="debugPbrBack.envMapIntensity"
        :color="debugPbrBack.color"
      />
    </TresMesh>
  </TresGroup>

  <TresAxesHelper v-if="showAxes" :args="[0.5]" />
  <Grid v-if="showGrid" :args="[10, 10]" cell-color="#666" section-color="#999" />

  <!-- enable-rotate désactivé : la rotation de la box vient de useGrabRotation.
       Les deux systèmes réagissant au même drag sur le canvas se battraient sinon. -->
  <OrbitControls :enable-rotate="false" />
  <Stats />
</template>
