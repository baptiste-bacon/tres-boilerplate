import { useLoop } from '@tresjs/core'
import type { Object3D } from 'three'
import type { MaybeRef } from 'vue'
import { unref } from 'vue'

export function useAutoRotate(target: MaybeRef<Object3D | undefined>, speed = 0.3) {
  const { onBeforeRender } = useLoop()

  onBeforeRender(({ delta }) => {
    const object = unref(target)
    if (!object) return
    object.rotation.y += delta * speed
  })
}
