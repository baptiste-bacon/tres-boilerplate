import { onUnmounted, ref, unref, watchEffect } from 'vue'
import type { MaybeRef } from 'vue'
import { useTres } from '@tresjs/core'

export interface UseHoverCursorOptions {
  /**
   * true tant qu'une interaction active (ex. drag) est en cours sur la cible :
   * prioritaire sur le survol, curseur `activeCursor`.
   */
  isActive?: MaybeRef<boolean>
  /** Curseur CSS pendant le survol (sans interaction active). Défaut 'grab'. */
  hoverCursor?: string
  /** Curseur CSS pendant l'interaction active. Défaut 'grabbing'. */
  activeCursor?: string
}

/**
 * Feedback curseur à 3 états (défaut du navigateur / hoverCursor / activeCursor) sur le
 * canvas du renderer TresJS courant. Piloté par le survol d'UNE cible précise (via les
 * handlers `onPointerEnter`/`onPointerLeave` à brancher sur les events natifs TresJS de
 * cette cible, ex. `@pointer-enter`/`@pointer-leave` sur un `<TresMesh>` — raycasting
 * géré par TresJS, pas de raycaster manuel ici) et par un état d'activité externe (ex.
 * `isDragging` d'un composable de grab). Agnostique de la cible et de l'outil
 * d'interaction : ne fait aucune hypothèse sur ce qu'ils représentent.
 *
 * Priorité isActive > hover > défaut : le curseur actif reste affiché pendant toute
 * l'interaction même si le pointeur quitte la géométrie de la cible en cours de route
 * (ex. l'objet tourne sous le curseur pendant un drag), et retombe naturellement sur
 * hoverCursor ou la valeur par défaut du navigateur selon le hover réel une fois
 * l'interaction terminée — jamais de curseur figé sur `activeCursor`.
 */
export function useHoverCursor(options: UseHoverCursorOptions = {}) {
  const isActive = options.isActive ?? false
  const hoverCursor = options.hoverCursor ?? 'grab'
  const activeCursor = options.activeCursor ?? 'grabbing'

  const { renderer } = useTres()
  const isHovering = ref(false)

  function onPointerEnter() {
    isHovering.value = true
  }

  function onPointerLeave() {
    isHovering.value = false
  }

  const stopWatch = watchEffect(() => {
    const element = renderer?.domElement
    if (!element) return
    element.style.cursor = unref(isActive) ? activeCursor : isHovering.value ? hoverCursor : ''
  })

  onUnmounted(() => {
    stopWatch()
    const element = renderer?.domElement
    if (element) element.style.cursor = ''
  })

  return { isHovering, onPointerEnter, onPointerLeave }
}
