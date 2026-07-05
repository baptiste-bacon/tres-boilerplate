import { onUnmounted, unref, watch } from 'vue'
import type { MaybeRef } from 'vue'
import { DirectionalLight, DirectionalLightHelper, PointLight, PointLightHelper, type Light } from 'three'
import { useLoop, useTres } from '@tresjs/core'

export interface LightHelperConfig {
  /** La lumière à visualiser (ref vers l'instance Three.js, ex. TresDirectionalLight ref="..."). */
  light: MaybeRef<Light | undefined>
  /** Couleur du helper, pour distinguer plusieurs lumières d'un coup d'œil. */
  color?: number | string
  /** Taille de l'icône du helper (DirectionalLightHelper) ou du repère sphérique (PointLightHelper). */
  size?: number
}

/**
 * Affiche/masque des helpers Three.js natifs (DirectionalLightHelper, PointLightHelper)
 * pour visualiser position + direction de lumières dans la scène. Outil de dev : à
 * garder isolé de la logique de rendu principale pour pouvoir le retirer facilement
 * d'un build de prod (il suffit de ne pas appeler ce composable).
 *
 * Monté/démonté conditionnellement selon `visible` (pas juste caché) : rien n'est
 * ajouté à la scène tant que c'est désactivé. `.update()` est appelé sur chaque helper
 * actif à chaque frame (la position/rotation de la lumière peut changer en direct via
 * un panneau de debug), sinon l'icône se fige et ne suit plus la lumière.
 */
export function useLightHelpers(lights: LightHelperConfig[], visible: MaybeRef<boolean>) {
  const { scene } = useTres()
  const { onBeforeRender } = useLoop()

  let active: Array<DirectionalLightHelper | PointLightHelper> = []

  function createHelpers() {
    if (active.length > 0 || !scene.value) return
    const created: typeof active = []
    for (const config of lights) {
      const light = unref(config.light)
      if (!light) continue
      let helper: DirectionalLightHelper | PointLightHelper | null = null
      if (light instanceof DirectionalLight) helper = new DirectionalLightHelper(light, config.size ?? 0.15, config.color)
      else if (light instanceof PointLight) helper = new PointLightHelper(light, config.size ?? 0.1, config.color)
      if (helper) {
        scene.value.add(helper)
        created.push(helper)
      }
    }
    active = created
  }

  function destroyHelpers() {
    for (const helper of active) {
      scene.value?.remove(helper)
      helper.dispose()
    }
    active = []
  }

  watch(() => unref(visible), (isVisible) => (isVisible ? createHelpers() : destroyHelpers()), { immediate: true })

  onBeforeRender(() => {
    for (const helper of active) helper.update()
  })

  onUnmounted(destroyHelpers)
}
