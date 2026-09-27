/**
 * Everything the rig UI needs, behind one module so the panel can load it
 * lazily (three-mesh-bvh, the clip library and the loaders stay out of the
 * main chunk until the user rigs a model).
 */
export { autoPlaceJoints, autoPlaceJointsDetailed, clampToSilhouette, type AutoJointResult, type JointMethod, type PlausibilityIssue, type Silhouette } from './autoJoints';
export { buildLibrary, CLIP_DEFS } from './animations';
export { collectMeshData, type MeshData } from './meshData';
export { hasSkinnedMeshes, jointWorldPosition, rigModel, type RigHandle, type RigViewer, type SpecUpdateOptions } from './rig';
export { AnimationPlayer, type FrameHost, type PlayOptions } from './player';
export { importAnimationFile, parseAnimationFile, retargetAnimation, MAX_IMPORT_MB, type AnimationSource, type ImportedClip } from './import';
export { JointEditor, type JointEditorHost } from './jointEditor';
export { describeRig, type RigDescriptor } from './skeleton';
// Generic skeletons (templates, animals, the rig editor).
export { autoPlaceAnimal, suggestTemplate, type AnimalAutoResult, type AnimalMethod, type TemplateSuggestion } from './autoAnimal';
export { ANIMAL_CLIPS, buildAnimalLibrary } from './animals';
export { emptySpec, proportionalSpec, TEMPLATE_INFO } from './templates';
export { boneMap, childrenOf, depthOf, findMirrorBone, humanoidSpecFromLayout, specSize, validateSpec, type SpecDescriptor } from './spec';
export * as ops from './editor/ops';
export * as keys from './editor/keyframes';
export { EditHistory, type HistoryEntry, type HistoryState } from './editor/history';
export { ikChains, RigEditorViewport, type BrushSettings, type EditorMode, type EditorPick, type ViewportCallbacks } from './editor/viewport';
export type { WeightDiff } from './editor/weightPaint';
