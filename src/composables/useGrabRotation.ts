import { onUnmounted, reactive, ref, unref, watchEffect } from 'vue'
import type { MaybeRef } from 'vue'
import { Quaternion, Vector3, type Object3D } from 'three'
import { useLoop, useTres, type TresPointerEvent } from '@tresjs/core'

// Yaw : axe Y du MONDE fixe, jamais recalculé -> l'horizon ne penche jamais, quel que
// soit le pitch déjà appliqué.
const WORLD_Y_AXIS = new Vector3(0, 1, 0)
// Pitch : axe X de la CAMÉRA (son "horizontale écran" courante), PAS l'axe X local de
// l'objet. Extrait à chaque recomposition depuis la matrice monde de la caméra (voir
// recompose ci-dessous). Un axe qui dépendrait de l'orientation de l'objet (son propre
// X local) donnerait un tangage qui s'inverse perceptuellement une fois l'objet
// retourné de 180° sur Y (le "haut de l'écran" et le "haut de l'objet" ne coïncident
// plus) : en ancrant le pitch sur l'axe de la caméra, qui ne bouge pas quand l'objet
// tourne, "vers le haut" produit toujours la même bascule perçue à l'écran, sur les
// deux faces.
const cameraRightAxis = new Vector3()
// Quaternions scratch réutilisés à chaque frame pour éviter des allocations. Servent à
// RECOMPOSER le quaternion final à partir des deux angles absolus (yawAngle,
// pitchAngle) — pas à accumuler des deltas sur le quaternion existant (voir recompose).
const yawQuat = new Quaternion()
const pitchQuat = new Quaternion()

// Ease-out cubique : démarre vite, ralentit en douceur en approchant la face cible.
function easeOutCubic(t: number) {
  const inv = 1 - t
  return 1 - inv * inv * inv
}

export interface UseGrabRotationOptions {
  /** Radians de rotation par pixel de déplacement du pointeur. */
  sensitivity?: MaybeRef<number>
  /**
   * Multiplicateur appliqué à la vélocité à chaque frame rendue pendant l'inertie
   * (ex. 0.95 = perd 5% de vitesse par frame). 1 = pas de friction, 0 = arrêt net.
   */
  damping?: MaybeRef<number>
  /** Mode présentoir : ignore le déplacement vertical, ne tourne que sur Y. */
  constrainToYAxis?: MaybeRef<boolean>
  /**
   * Limite [rad] du clamp doux, symétrique autour de 0, sur le pitch total (bascule
   * avant/arrière autour de l'axe X courant de la caméra) appliqué par cet outil, ou
   * null pour désactiver. Résistance progressive à l'approche de la limite (tanh),
   * jamais de mur net : évite les retournements complets sans à-coup.
   */
  verticalClampLimit?: MaybeRef<number | null>
  /** Vélocité angulaire (rad/s) en dessous de laquelle l'inertie s'arrête net. */
  minAngularVelocity?: number
  /**
   * Snap au relâchement sur une face (recto ou verso, yaw multiple de π), pitch remis
   * à plat (0). Désactivé = rotation totalement libre après relâchement (inertie pure).
   */
  snapEnabled?: MaybeRef<boolean>
  /**
   * Vélocité de yaw (rad/s) au-delà de laquelle la face cible du snap suit la
   * direction du lancer plutôt que la face la plus proche à l'instant du relâchement.
   */
  snapVelocityThreshold?: MaybeRef<number>
  /** Durée (s) de l'animation de snap (slerp, ease-out). */
  snapDuration?: MaybeRef<number>
}

/**
 * Rotation d'un Object3D au grab (pointer events, souris + tactile unifiés), avec
 * inertie : la vélocité angulaire calculée pendant le drag continue de s'appliquer
 * au relâchement, atténuée par `damping` à chaque frame jusqu'à extinction. Un
 * nouveau grab interrompt l'inertie (ou le snap) en cours et reprend le contrôle
 * immédiatement.
 *
 * Rotation appliquée via quaternions, jamais en accumulation d'angles d'Euler sur
 * `object.rotation` (gimbal). Le quaternion final est RECOMPOSÉ à chaque changement à
 * partir de deux angles absolus indépendants (yawAngle, pitchAngle), jamais accumulé
 * par petits deltas successifs sur le quaternion existant : `quaternion =
 * Pitch_caméra(pitchAngle) * Yaw_monde(yawAngle)`. Yaw autour de l'axe Y monde fixe :
 * l'horizon ne penche jamais. Pitch autour de l'axe X de la CAMÉRA (pas de l'objet),
 * appliqué en dernier (le plus extérieur) : "vers le haut" bascule toujours le même
 * sens perçu à l'écran, sur le recto comme sur le verso, quel que soit le yaw déjà
 * accumulé (voir commentaire sur cameraRightAxis). Recomposer depuis deux scalaires
 * plutôt qu'accumuler des deltas est nécessaire ici : un delta de pitch prémultiplié
 * sur l'axe caméra ne commute pas avec un delta de yaw prémultiplié sur l'axe Y monde,
 * donc l'ordre d'entrelacement changerait le résultat final si on accumulait
 * incrémentalement — en recomposant depuis (yawAngle, pitchAngle) avec un ordre fixe à
 * chaque fois, le résultat ne dépend que des sommes totales, jamais de l'ordre du
 * geste, ce qui est indispensable pour que yawAngle reste une source de vérité fiable
 * pour la décision de snap.
 *
 * Au relâchement (si `snapEnabled`), la pochette se cale en douceur (slerp, ease-out)
 * sur la face recto ou verso la plus proche, à plat (pitch 0) — sauf si la vélocité de
 * yaw dépasse `snapVelocityThreshold`, auquel cas la face cible suit la direction du
 * lancer même si l'autre face était légèrement plus proche à l'instant du lâcher.
 * L'inertie n'est jamais relancée en parallèle du snap : la vélocité au lâcher sert
 * uniquement à décider la face cible, puis la transition se fait entièrement via le
 * slerp de snap (pas de rupture visible entre "ça tourne encore" et "ça se cale").
 *
 * Ne s'active QUE sur un pointer-down effectif sur le mesh cible : n'attache aucun
 * listener `pointerdown` global sur le canvas. Le grab doit être démarré explicitement
 * en branchant `startGrab` (la fonction retournée) sur l'événement natif TresJS
 * `@pointer-down` du mesh visé (raycasting géré par TresJS, agnostique de la cible).
 * pointermove/up/cancel, eux, restent écoutés sur tout le canvas du renderer TresJS
 * courant une fois le grab démarré, pour que le drag continue même si le pointeur
 * quitte la géométrie du mesh en cours de route. Appeler depuis un composant
 * descendant de <TresCanvas>.
 */
export function useGrabRotation(target: MaybeRef<Object3D | undefined>, options: UseGrabRotationOptions = {}) {
  const sensitivity = options.sensitivity ?? 0.01
  const damping = options.damping ?? 0.95
  const constrainToYAxis = options.constrainToYAxis ?? false
  const verticalClampLimit = options.verticalClampLimit ?? null
  const minAngularVelocity = options.minAngularVelocity ?? 0.001
  const snapEnabled = options.snapEnabled ?? true
  const snapVelocityThreshold = options.snapVelocityThreshold ?? 1.5
  const snapDuration = options.snapDuration ?? 0.45

  const { renderer, camera } = useTres()
  const { onBeforeRender } = useLoop()

  const isDragging = ref(false)
  // true pendant l'animation de snap post-relâchement (slerp vers la face cible).
  const isSnapping = ref(false)
  // Vélocité angulaire courante, en rad/s (x = pitch autour de l'axe X courant de la
  // caméra, y = yaw autour de l'axe Y monde). Jamais interprétée comme de l'Euler.
  const velocity = reactive({ x: 0, y: 0 })

  let activePointerId: number | null = null
  let lastX = 0
  let lastY = 0
  let lastTime = 0

  // Yaw total (rad), non modulo : somme de tous les deltas de yaw appliqués. Puisque le
  // quaternion final est RECOMPOSÉ (jamais accumulé par deltas, voir recompose),
  // object.quaternion == Pitch(pitchAngle) * Yaw(yawAngle) en permanence, exactement,
  // quel que soit l'ordre d'entrelacement des gestes de drag. yawAngle est donc une
  // source de vérité fiable pour décider la face cible du snap (multiple de π le plus
  // proche), sans avoir à décomposer le quaternion final.
  let yawAngle = 0
  // Pitch total APPLIQUÉ (après clamp doux), dérivé de pitchRaw ci-dessous. Sert de
  // base pour le clamp doux du prochain delta (voir applyRotation).
  let pitchAngle = 0
  // Somme brute, non clampée, de tous les deltas de pitch : la valeur "physique" que la
  // souris a demandée, indépendamment de la résistance du clamp. pitchAngle est dérivé
  // de pitchRaw à chaque frame via tanh (voir applyRotation), jamais l'inverse : ça
  // permet à l'utilisateur de "revenir en arrière" depuis la butée sans rester coincé
  // (contrairement à un clamp dur qui perdrait l'info de dépassement).
  let pitchRaw = 0

  // État de l'animation de snap en cours (slerp start -> target sur `snapElapsed`
  // secondes, cf. onBeforeRender). Quaternions scratch dédiés à cette instance : ils
  // doivent survivre entre les frames, contrairement aux quaternions transitoires
  // yawQuat/pitchQuat partagés au niveau module.
  const snapStartQuat = new Quaternion()
  const snapTargetQuat = new Quaternion()
  let snapElapsed = 0
  let snapTargetYaw = 0

  // Reconstruit object.quaternion depuis les deux angles absolus courants (yawAngle,
  // pitchAngle), avec un ordre fixe : yaw d'abord (le plus intérieur), pitch ensuite
  // (le plus extérieur, autour de l'axe X courant de la CAMÉRA). Voir la docstring
  // principale pour pourquoi une recomposition complète est nécessaire ici plutôt
  // qu'une accumulation incrémentale de deltas.
  function recompose(object: Object3D) {
    const activeCamera = camera?.value
    if (activeCamera) {
      cameraRightAxis.setFromMatrixColumn(activeCamera.matrixWorld, 0).normalize()
    } else {
      cameraRightAxis.set(1, 0, 0)
    }
    yawQuat.setFromAxisAngle(WORLD_Y_AXIS, yawAngle)
    pitchQuat.setFromAxisAngle(cameraRightAxis, pitchAngle)
    object.quaternion.copy(pitchQuat).multiply(yawQuat)
  }

  function applyRotation(deltaYaw: number, deltaPitch: number) {
    const object = unref(target)
    if (!object) return

    let changed = false

    if (deltaYaw !== 0) {
      yawAngle += deltaYaw
      changed = true
    }

    if (!unref(constrainToYAxis) && deltaPitch !== 0) {
      pitchRaw += deltaPitch
      const limit = unref(verticalClampLimit)
      // Clamp doux : tanh ramène pitchRaw (non borné) dans [-limit, limit] avec une
      // résistance qui croît progressivement en approchant la limite (jamais de mur
      // net, toujours réversible en revenant en arrière), plutôt qu'un clamp dur sur la
      // valeur appliquée qui perdrait le "dépassement demandé" et collerait net à la
      // butée.
      pitchAngle = limit ? limit * Math.tanh(pitchRaw / limit) : pitchRaw
      changed = true
    }

    if (changed) recompose(object)
  }

  // Face cible du snap : multiple de π le plus proche de yawAngle (recto = pair,
  // verso = impair), sauf si la vélocité de yaw au lâcher dépasse le seuil -> dans ce
  // cas on prend la face suivante dans le sens du lancer, même si l'autre face était
  // encore un peu plus proche à l'instant du relâchement (intention du geste > proximité).
  function decideSnapTargetYaw(): number {
    const k = yawAngle / Math.PI
    const threshold = unref(snapVelocityThreshold)
    if (Math.abs(velocity.y) > threshold) {
      return velocity.y > 0 ? (Math.floor(k) + 1) * Math.PI : (Math.ceil(k) - 1) * Math.PI
    }
    return Math.round(k) * Math.PI
  }

  function startSnap() {
    const object = unref(target)
    if (!object) return
    snapTargetYaw = decideSnapTargetYaw()
    snapStartQuat.copy(object.quaternion)
    // Pitch cible toujours 0 (à plat) : setFromAxisAngle sur le seul axe Y monde donne
    // directement Yaw(snapTargetYaw) * Pitch(0), pas besoin de composer un pitch.
    snapTargetQuat.setFromAxisAngle(WORLD_Y_AXIS, snapTargetYaw)
    snapElapsed = 0
    isSnapping.value = true
    // L'inertie ne reprend jamais en parallèle du snap : la vélocité a déjà servi à
    // décider la cible ci-dessus, elle n'a plus lieu d'être une fois la transition lancée.
    velocity.x = 0
    velocity.y = 0
  }

  function cancelSnap() {
    if (!isSnapping.value) return
    isSnapping.value = false
    // Un nouveau grab interrompt le snap en plein vol. object.quaternion, à cet
    // instant, est un slerp entre snapStartQuat (pose quelconque, potentiellement avec
    // du pitch) et snapTargetQuat (pure Yaw, pitch 0) : ce point intermédiaire n'est en
    // général PAS exactement décomposable en Pitch(p)*Yaw(y), donc on ne peut
    // qu'approximer. yawAngle est extrait via une décomposition swing-twist autour de
    // l'axe Y monde (2*atan2(q.y, q.w), exacte quel que soit le pitch résiduel mélangé
    // dedans) ; pitchAngle est remis à 0 (le snap visait de toute façon le plat). Comme
    // applyRotation RECOMPOSE désormais le quaternion à partir de ces deux scalaires
    // (au lieu d'accumuler des deltas sur le quaternion existant), il faut les
    // resynchroniser avec la pose réelle ET rappliquer immédiatement cette
    // recomposition ici, sinon le prochain applyRotation sauterait visuellement de la
    // pose mi-slerp vers la pose recomposée. Léger raidissement du pitch résiduel vers
    // 0 à cet instant précis : négligeable, et cohérent avec l'intention ("je reprends
    // la main, ça se stabilise").
    const object = unref(target)
    if (object) {
      const q = object.quaternion
      yawAngle = 2 * Math.atan2(q.y, q.w)
      pitchRaw = 0
      pitchAngle = 0
      recompose(object)
    }
  }

  // Point d'entrée du grab : à brancher sur l'événement `@pointer-down` NATIF DE TRESJS
  // du mesh cible (raycasting géré par TresJS, pas de raycaster manuel ici). C'est ce
  // qui garantit qu'un pointer-down dans le vide (hors mesh) ne déclenche jamais de
  // rotation : cette fonction n'est tout simplement jamais appelée dans ce cas, faute
  // d'intersection. pointermove/up restent écoutés au niveau du canvas (voir attach) :
  // une fois le grab commencé, le drag doit continuer même si le pointeur quitte la
  // géométrie du mesh en cours de route.
  function startGrab(event: TresPointerEvent) {
    if (!attachedElement) return
    // event.pointerId est un id INTERNE à la lib d'event TresJS (généré par
    // generateUniquePointerId), pas le pointerId natif du navigateur : les listeners
    // pointermove/up ci-dessous sont attachés en DOM brut sur le canvas (voir attach)
    // et reçoivent le vrai PointerEvent natif, avec le vrai pointerId. Il faut lire
    // celui-là (event.nativeEvent.pointerId) pour que le matching activePointerId
    // fonctionne, sinon plus aucun pointermove/up n'est reconnu après le grab.
    // Cast nécessaire : TresPointerEvent type nativeEvent en MouseEvent (générique de
    // la lib upstream), alors qu'à l'exécution, pour un pointerdown, c'est bien un
    // PointerEvent natif (pointerId présent).
    const nativePointerId = (event.nativeEvent as unknown as globalThis.PointerEvent).pointerId
    cancelSnap()
    isDragging.value = true
    activePointerId = nativePointerId
    lastX = event.clientX
    lastY = event.clientY
    lastTime = performance.now()
    // Un nouveau grab interrompt l'inertie en cours.
    velocity.x = 0
    velocity.y = 0
    try {
      attachedElement.setPointerCapture(nativePointerId)
    } catch {
      // Pointer déjà relâché ou id invalide (ex. multi-touch rapide) : sans incidence,
      // pointermove/up continuent de fonctionner tant que le pointeur reste sur l'élément.
    }
    event.nativeEvent.preventDefault?.()
  }

  function onPointerMove(event: PointerEvent) {
    if (!isDragging.value || event.pointerId !== activePointerId) return
    event.preventDefault()

    const now = performance.now()
    const dt = Math.max((now - lastTime) / 1000, 1 / 1000)
    const dx = event.clientX - lastX
    const dy = event.clientY - lastY
    const s = unref(sensitivity)
    const deltaYaw = dx * s
    // dy > 0 = drag vers le bas. Signe à valider empiriquement contre le rendu réel
    // (voir doc du composable) : le pitch tourne désormais autour de l'axe caméra, pas
    // de l'axe local de l'objet, donc la convention de signe précédente ne s'applique
    // plus telle quelle.
    const deltaPitch = dy * s

    applyRotation(deltaYaw, deltaPitch)

    // Vélocité instantanée : reprise telle quelle par l'inertie (ou la décision de
    // snap) au relâchement.
    velocity.y = deltaYaw / dt
    velocity.x = deltaPitch / dt

    lastX = event.clientX
    lastY = event.clientY
    lastTime = now
  }

  function onPointerUp(event: PointerEvent) {
    if (event.pointerId !== activePointerId) return
    isDragging.value = false
    activePointerId = null
    if (unref(snapEnabled)) startSnap()
  }

  let attachedElement: HTMLElement | null = null

  function attach(element: HTMLElement) {
    if (attachedElement === element) return
    detach()
    attachedElement = element
    // Empêche le scroll/geste tactile par défaut du navigateur pendant le drag.
    element.style.touchAction = 'none'
    element.addEventListener('pointermove', onPointerMove)
    element.addEventListener('pointerup', onPointerUp)
    element.addEventListener('pointercancel', onPointerUp)
  }

  function detach() {
    if (!attachedElement) return
    attachedElement.removeEventListener('pointermove', onPointerMove)
    attachedElement.removeEventListener('pointerup', onPointerUp)
    attachedElement.removeEventListener('pointercancel', onPointerUp)
    attachedElement = null
  }

  const stopWatch = watchEffect(() => {
    const element = renderer?.domElement
    if (element) attach(element)
  })

  onBeforeRender(({ delta }) => {
    if (isDragging.value) return

    if (isSnapping.value) {
      const object = unref(target)
      if (!object) return
      snapElapsed += delta
      const duration = Math.max(unref(snapDuration), 0.001)
      const t = Math.min(snapElapsed / duration, 1)
      const eased = easeOutCubic(t)
      object.quaternion.slerpQuaternions(snapStartQuat, snapTargetQuat, eased)
      if (t >= 1) {
        isSnapping.value = false
        // Copie exacte de la cible en fin d'anim : évite toute dérive flottante
        // résiduelle du slerp, la pochette est pile à plat sur sa face.
        object.quaternion.copy(snapTargetQuat)
        yawAngle = snapTargetYaw
        pitchRaw = 0
        pitchAngle = 0
      }
      return
    }

    if (Math.abs(velocity.x) < minAngularVelocity && Math.abs(velocity.y) < minAngularVelocity) {
      velocity.x = 0
      velocity.y = 0
      return
    }
    applyRotation(velocity.y * delta, velocity.x * delta)
    const d = unref(damping)
    velocity.x *= d
    velocity.y *= d
  })

  onUnmounted(() => {
    detach()
    stopWatch()
  })

  return { isDragging, isSnapping, velocity, startGrab }
}
