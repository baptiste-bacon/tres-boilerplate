import { onUnmounted, unref, watchEffect } from 'vue'
import type { MaybeRef } from 'vue'
import type { Object3D } from 'three'
import { useLoop, useTres } from '@tresjs/core'

export interface UseMouseTiltOptions {
  /** Amplitude max du tilt, en radians. Défaut ~0.15 rad (~8.6°). */
  maxAngle?: MaybeRef<number>
  /** Facteur de lissage du lerp par frame (0-1). Bas = mouvement mou/retardé, haut = plus nerveux. Défaut 0.1. */
  smoothing?: MaybeRef<number>
  /**
   * Coupe le tilt quand false (ex. pendant un grab actif) : la cible retombe à 0 et
   * l'objet revient en douceur au repos, plutôt que de se figer brutalement. Défaut true.
   */
  enabled?: MaybeRef<boolean>
}

/**
 * Tilt passif au survol de la souris (pas de clic) : penche `target` légèrement vers
 * le curseur, avec un retard élastique (lerp vers une cible plutôt qu'un mapping
 * direct). Purement une rotation LOCALE de `target` définie à chaque frame depuis
 * deux angles lissés (pas d'accumulation) : à utiliser sur un objet dédié à cet effet
 * (ex. le mesh, pendant qu'un composable comme useGrabRotation pilote son parent) pour
 * ne pas se battre avec une autre logique de rotation sur le même objet.
 *
 * Souris absente du canvas -> cible 0 (repos). Tactile non géré : au repos par défaut,
 * rien ne casse en son absence.
 */
export function useMouseTilt(target: MaybeRef<Object3D | undefined>, options: UseMouseTiltOptions = {}) {
  const maxAngle = options.maxAngle ?? 0.15
  const smoothing = options.smoothing ?? 0.1
  const enabled = options.enabled ?? true

  const { renderer } = useTres()
  const { onBeforeRender } = useLoop()

  let mouseX = 0
  let mouseY = 0
  let hovering = false
  let currentPitch = 0
  let currentYaw = 0

  function onPointerMove(event: PointerEvent) {
    const element = event.currentTarget as HTMLElement
    const rect = element.getBoundingClientRect()
    mouseX = ((event.clientX - rect.left) / rect.width) * 2 - 1
    mouseY = ((event.clientY - rect.top) / rect.height) * 2 - 1
    hovering = true
  }

  function onPointerLeave() {
    hovering = false
  }

  let attachedElement: HTMLElement | null = null

  function attach(element: HTMLElement) {
    if (attachedElement === element) return
    detach()
    attachedElement = element
    element.addEventListener('pointermove', onPointerMove)
    element.addEventListener('pointerleave', onPointerLeave)
  }

  function detach() {
    if (!attachedElement) return
    attachedElement.removeEventListener('pointermove', onPointerMove)
    attachedElement.removeEventListener('pointerleave', onPointerLeave)
    attachedElement = null
  }

  const stopWatch = watchEffect(() => {
    const element = renderer?.domElement
    if (element) attach(element)
  })

  onBeforeRender(() => {
    const object = unref(target)
    if (!object) return

    const isActive = unref(enabled) && hovering
    const angle = unref(maxAngle)
    // Même convention de signe que useGrabRotation (souris en bas -> le haut bascule
    // vers l'arrière, pas l'inverse), pour un feeling cohérent entre survol et grab.
    const targetYaw = isActive ? mouseX * angle : 0
    const targetPitch = isActive ? -mouseY * angle : 0

    const s = unref(smoothing)
    currentYaw += (targetYaw - currentYaw) * s
    currentPitch += (targetPitch - currentPitch) * s

    object.rotation.set(currentPitch, currentYaw, 0)
  })

  onUnmounted(() => {
    detach()
    stopWatch()
  })
}
