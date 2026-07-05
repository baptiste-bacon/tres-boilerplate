<script setup lang="ts">
import { TresCanvas } from '@tresjs/core'
import Experience from './Experience.vue'
import { CAMERA_POSITION, CAMERA_FOV, COLORS } from '../config/scene'
</script>

<template>
  <TresCanvas :clear-color="COLORS.background" window-size>
    <TresPerspectiveCamera :position="CAMERA_POSITION" :fov="CAMERA_FOV" :look-at="[0, 0, 0]" />
    <Experience />
  </TresCanvas>
</template>
