# TresJS Boilerplate

Boilerplate minimal pour projets créatifs WebGL avec Vue 3 + TresJS.

## Démarrer

```bash
npm install
npm run dev
```

## Structure

- `src/scene/` — composants 3D (`Scene.vue` monte le `TresCanvas` et la caméra, `Experience.vue` contient le contenu de la scène)
- `src/composables/` — logique réutilisable (ex: `useAutoRotate`)
- `src/shaders/` — fichiers `.glsl` ou TSL (import direct grâce à `vite-plugin-glsl`)
- `src/config/` — constantes (dimensions, couleurs, positions)

## Helpers de dev

Dans `Experience.vue` : `showGrid` et `showAxes` contrôlent le `Grid` et l'`AxesHelper` (désactivés par défaut, passer à `true` pour les afficher). `OrbitControls` et le compteur `Stats` (FPS) sont actifs par défaut.

## Ajouter du contenu

- Nouveau mesh/objet : ajouter un composant dans `src/scene/` et l'importer dans `Experience.vue`
- Shader custom : déposer les `.glsl` dans `src/shaders/`, les importer (`import frag from '../shaders/foo.frag.glsl'`) et les passer à un `TresShaderMaterial`
# tres-boilerplate
# tres-mairo-bliss
