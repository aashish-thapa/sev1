"""Converts Rocketbox FBX files to glTF inside headless Blender.

  blender -b --factory-startup -P rocketbox.py -- avatar <in.fbx> <out.glb>
  blender -b --factory-startup -P rocketbox.py -- clip <in.fbx> <out.glb> <clip-name> [--in-place]
"""

import os
import sys

import bpy

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_fbx(path):
    bpy.ops.import_scene.fbx(filepath=path, use_anim=True, automatic_bone_orientation=False, ignore_leaf_bones=True)


def armature():
    found = [obj for obj in bpy.data.objects if obj.type == "ARMATURE"]
    if len(found) != 1:
        raise SystemExit(f"expected one armature, found {len(found)}")
    return found[0]


def export_glb(path, with_animation):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_animations=with_animation,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_frame_step=1,
        export_skins=True,
        export_morph=False,
        export_yup=True,
        export_apply=False,
        export_image_format="AUTO",
    )


def relink_images(texture_dir):
    """The FBX files point at the artists' machine; the maps sit in the avatar's Textures folder."""
    for image in bpy.data.images:
        image.filepath = os.path.join(texture_dir, os.path.basename(image.filepath.replace("\\", "/")))
        image.reload()


def tidy_material(material):
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    shader = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    # The specular maps read as plastic under glTF's specular extension; skin and cloth are rough.
    for link in list(shader.inputs["Specular IOR Level"].links):
        nodes.remove(link.from_node)
    shader.inputs["Roughness"].default_value = 0.72
    shader.inputs["Metallic"].default_value = 0.0
    # Hair and lashes keep their cut-out in the colour map's alpha; a second copy of the map feeds Alpha.
    alpha_links = list(shader.inputs["Alpha"].links)
    if alpha_links:
        colour = shader.inputs["Base Color"].links[0].from_node
        nodes.remove(alpha_links[0].from_node)
        links.new(colour.outputs["Alpha"], shader.inputs["Alpha"])


def convert_avatar(source, target):
    import_fbx(source)
    relink_images(os.path.join(os.path.dirname(source), "..", "Textures"))
    for obj in bpy.data.objects:
        obj.animation_data_clear()
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    for material in bpy.data.materials:
        if material.node_tree:
            tidy_material(material)
    export_glb(target, with_animation=False)


def fcurves(action):
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                yield from bag.fcurves


def pin_horizontal_root(rig):
    """Rocketbox walks carry root motion on the rig's own location; pin X/Y so the walk plays on the spot."""
    for curve in fcurves(rig.animation_data.action):
        if curve.data_path == "location" and curve.array_index in (0, 1):
            start = curve.keyframe_points[0].co[1]
            for point in curve.keyframe_points:
                point.co[1] = start
                point.handle_left[1] = start
                point.handle_right[1] = start


def convert_clip(source, target, name, is_in_place):
    import_fbx(source)
    rig = armature()
    for obj in list(bpy.data.objects):
        if obj != rig:
            bpy.data.objects.remove(obj, do_unlink=True)
    for unused in [candidate for candidate in bpy.data.actions if candidate.users == 0]:
        bpy.data.actions.remove(unused)
    action = rig.animation_data.action if rig.animation_data else None
    if action is None:
        raise SystemExit(f"{source} has no animation")
    action.name = name
    if is_in_place:
        pin_horizontal_root(rig)
    start, end = action.frame_range
    bpy.context.scene.frame_start = int(start)
    bpy.context.scene.frame_end = int(end)
    export_glb(target, with_animation=True)


def main():
    args = sys.argv[sys.argv.index("--") + 1 :]
    mode, source, target = args[:3]
    reset_scene()
    if mode == "avatar":
        convert_avatar(source, target)
    elif mode == "clip":
        convert_clip(source, target, args[3], "--in-place" in args)
    else:
        raise SystemExit(f"unknown mode {mode}")


main()
