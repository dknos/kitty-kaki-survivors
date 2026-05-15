"""Headless Blender polish pass for static-mesh hero GLBs.

Imports a GLB, recenters the pivot so feet sit at Y=0 and XZ-center is 0,
cleans the mesh (merge-by-distance, recalc normals), shades smooth with
auto-smooth at 30°, applies a weighted-normals pass, and tunes the
Principled BSDF (roughness floor + reduced specular) for less Rodin-shine.
Exports a fresh GLB. Designed to run as:

    blender --background --python tools/blender-polish.py -- IN.glb OUT.glb
"""
import bpy
import sys
import os
import math
import mathutils


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def gather_meshes():
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']


def recenter(meshes):
    # Blender is Z-up. After import_scene.gltf, the original glTF Y-up axis is
    # remapped to Blender Z. So in Blender world coords:
    #   X, Y = floor plane (horizontal)
    #   Z    = vertical (feet at min, head at max)
    # On export the inverse remap restores glTF Y-up. So we must:
    #   horizontal center = bbox XY midpoint
    #   feet              = bbox min Z
    minv = mathutils.Vector(( math.inf,)*3)
    maxv = mathutils.Vector((-math.inf,)*3)
    for o in meshes:
        for v in o.bound_box:
            wv = o.matrix_world @ mathutils.Vector(v)
            for i in range(3):
                if wv[i] < minv[i]: minv[i] = wv[i]
                if wv[i] > maxv[i]: maxv[i] = wv[i]
    cx = (minv.x + maxv.x) * 0.5
    cy = (minv.y + maxv.y) * 0.5
    cz = minv.z
    for o in meshes:
        o.location.x -= cx
        o.location.y -= cy
        o.location.z -= cz
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)


def clean_mesh(o):
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o

    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.0001)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')

    # Shade smooth by angle (Blender 4.1+)
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(30))
    except Exception:
        bpy.ops.object.shade_smooth()

    # Weighted-normals modifier — gives clean smoothing across hard edges
    wn = o.modifiers.new('WN', 'WEIGHTED_NORMAL')
    wn.weight = 50
    wn.keep_sharp = True
    bpy.ops.object.modifier_apply(modifier='WN')


def tune_materials(o):
    for slot in o.material_slots:
        m = slot.material
        if not m or not m.use_nodes:
            continue
        for n in m.node_tree.nodes:
            if n.type != 'BSDF_PRINCIPLED':
                continue
            r = n.inputs.get('Roughness')
            if r and not r.is_linked:
                r.default_value = max(0.4, r.default_value)
            s = n.inputs.get('Specular IOR Level')
            if s and not s.is_linked:
                s.default_value = min(0.35, s.default_value)


def polish(in_path, out_path):
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=in_path)
    meshes = gather_meshes()
    if not meshes:
        raise SystemExit(f'no meshes imported from {in_path}')

    recenter(meshes)
    for o in meshes:
        clean_mesh(o)
        tune_materials(o)

    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format='GLB',
        export_apply=True,
        export_materials='EXPORT',
        export_image_format='AUTO',
        use_selection=False,
    )


def main():
    args = sys.argv
    if '--' not in args:
        raise SystemExit('usage: blender -b -P blender-polish.py -- IN.glb OUT.glb')
    i = args.index('--')
    if len(args) < i + 3:
        raise SystemExit('expected IN.glb OUT.glb after --')
    polish(args[i + 1], args[i + 2])


if __name__ == '__main__':
    main()
