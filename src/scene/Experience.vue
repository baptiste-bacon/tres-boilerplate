<script setup lang="ts">
import { ref } from 'vue'
import { OrbitControls, Grid, Stats } from '@tresjs/cientos'
import type { Mesh } from 'three'
import { useAutoRotate } from '../composables/useAutoRotate'
import {
  VINYL_SLEEVE_SIZE,
  COLORS,
  AMBIENT_LIGHT_INTENSITY,
  DIRECTIONAL_LIGHT_INTENSITY,
  DIRECTIONAL_LIGHT_POSITION,
  ROTATION_SPEED,
} from '../config/scene'

const showGrid = ref(false)
const showAxes = ref(false)

const planeRef = ref<Mesh>()
useAutoRotate(planeRef, ROTATION_SPEED)
</script>

<template>
  <TresAmbientLight :color="COLORS.ambientLight" :intensity="AMBIENT_LIGHT_INTENSITY" />
  <TresDirectionalLight
    :color="COLORS.directionalLight"
    :intensity="DIRECTIONAL_LIGHT_INTENSITY"
    :position="DIRECTIONAL_LIGHT_POSITION"
  />

  <TresMesh ref="planeRef">
    <TresPlaneGeometry :args="[VINYL_SLEEVE_SIZE, VINYL_SLEEVE_SIZE]" />
    <TresMeshStandardMaterial :color="COLORS.plane" :side="2" />
  </TresMesh>

  <TresAxesHelper v-if="showAxes" :args="[0.5]" />
  <Grid v-if="showGrid" :args="[10, 10]" cell-color="#666" section-color="#999" />

  <OrbitControls />
  <Stats />
</template>
