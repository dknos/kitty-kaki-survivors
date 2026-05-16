"""Headless Blender thumbnail of a GLB hero.

Usage: blender --background --python tools/blender-thumbnail.py -- IN.glb OUT.png
"""
import bpy, sys, math, mathutils


def main():
    args = sys.argv
    if '--' not in args:
        raise SystemExit('usage: blender -b -P thumbnail.py -- IN.glb OUT.png')
    i = args.index('--')
    in_path, out_path = args[i + 1], args[i + 2]

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=in_path)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not meshes:
        raise SystemExit('no meshes in GLB')

    # bbox in world space
    minv = mathutils.Vector(( math.inf,) * 3)
    maxv = mathutils.Vector((-math.inf,) * 3)
    for o in meshes:
        for v in o.bound_box:
            wv = o.matrix_world @ mathutils.Vector(v)
            for k in range(3):
                if wv[k] < minv[k]: minv[k] = wv[k]
                if wv[k] > maxv[k]: maxv[k] = wv[k]
    size = maxv - minv
    height = size.z
    cx = (minv.x + maxv.x) * 0.5
    cy = (minv.y + maxv.y) * 0.5
    cz = (minv.z + maxv.z) * 0.5

    # camera: 3/4 front view, distance scaled to height
    dist = max(2.5, height * 2.4)
    cam_data = bpy.data.cameras.new('Cam')
    cam_data.lens = 50
    cam = bpy.data.objects.new('Cam', cam_data)
    cam.location = (cx + dist * 0.78, cy - dist * 0.78, cz + height * 0.15)
    look = mathutils.Vector((cx, cy, cz + height * 0.05))
    dir_v = look - mathutils.Vector(cam.location)
    cam.rotation_euler = dir_v.to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    # 3-point lights
    key_data = bpy.data.lights.new('Key', 'AREA')
    key_data.energy = 800; key_data.size = 2.0
    key = bpy.data.objects.new('Key', key_data)
    key.location = (cx + 3, cy - 3, cz + height + 1.5)
    bpy.context.scene.collection.objects.link(key)

    fill_data = bpy.data.lights.new('Fill', 'AREA')
    fill_data.energy = 250; fill_data.size = 3.0; fill_data.color = (0.6, 0.85, 1.0)
    fill = bpy.data.objects.new('Fill', fill_data)
    fill.location = (cx - 3, cy - 2, cz + height * 0.5)
    bpy.context.scene.collection.objects.link(fill)

    rim_data = bpy.data.lights.new('Rim', 'AREA')
    rim_data.energy = 400; rim_data.size = 1.5; rim_data.color = (1.0, 0.85, 0.65)
    rim = bpy.data.objects.new('Rim', rim_data)
    rim.location = (cx, cy + 3, cz + height + 1.0)
    bpy.context.scene.collection.objects.link(rim)

    # ground plane for shadow context
    bpy.ops.mesh.primitive_plane_add(size=6, location=(cx, cy, minv.z))
    plane = bpy.context.object
    pmat = bpy.data.materials.new('Ground')
    pmat.use_nodes = True
    bsdf = pmat.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs['Base Color'].default_value = (0.10, 0.12, 0.13, 1.0)
        bsdf.inputs['Roughness'].default_value = 0.6
    plane.data.materials.append(pmat)

    s = bpy.context.scene
    s.render.engine = 'BLENDER_EEVEE'
    s.render.resolution_x = 512
    s.render.resolution_y = 512
    s.render.image_settings.file_format = 'PNG'
    s.render.filepath = out_path
    s.eevee.taa_render_samples = 32 if hasattr(s.eevee, 'taa_render_samples') else 32
    s.world = bpy.data.worlds.new('W') if not s.world else s.world
    s.world.use_nodes = True
    bg = s.world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = (0.04, 0.05, 0.06, 1.0)
        bg.inputs[1].default_value = 1.0

    bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    main()
