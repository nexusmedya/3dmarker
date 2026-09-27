/**
 * Everything the rig UI needs, behind one module so the panel can load it
 * lazily (three-mesh-bvh, the clip library and the loaders stay out of the
 * main chunk until the user rigs a model).
 */
export { autoPlaceJoints, autoPlaceJointsDetailed, clampToSilhouette, type AutoJointResult, type JointMethod, type PlausibilityIssue, type Silhouette } from './autoJoints';
export { buildLibrary, CLIP_DEFS } from './animations';
export { collectMeshData, type MeshData } from './meshData';
export { hasSkinnedMeshes, jointWorldPosition, rigModel, type RigHandle, type RigViewer } from './rig';
export { AnimationPlayer, type FrameHost, type PlayOptions } from './player';
export { importAnimationFile, parseAnimationFile, retargetAnimation, MAX_IMPORT_MB, type AnimationSource, type ImportedClip } from './import';
export { JointEditor, type JointEditorHost } from './jointEditor';
export { describeRig, type RigDescriptor } from './skeleton';
