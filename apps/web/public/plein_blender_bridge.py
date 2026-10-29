"""Exchange Plein compositions and Blender-rendered media using local files.

This add-on only reads a user-selected local JSON file. It does not connect to
Plein or execute code from the file. Import adds a collection; it never deletes
existing Blender objects.
"""

bl_info = {
    "name": "Plein 3D 构图与渲染",
    "author": "Plein",
    "version": (1, 1, 0),
    "blender": (3, 6, 0),
    "location": "File > Import; View3D > Sidebar > Plein",
    "description": "导入 Plein 构图，渲染图片和视频供 Plein 使用",
    "category": "Import-Export",
}

import json
import math
from pathlib import Path

import bpy
from bpy.props import StringProperty
from bpy_extras.io_utils import ExportHelper, ImportHelper
from mathutils import Euler, Matrix, Vector

MAX_BYTES = 2 * 1024 * 1024
FPS = 24
KINDS = {"box", "wall", "table", "chair", "door", "bed"}
POSES = {"stand", "walk", "run", "sit", "point", "cross", "kneel", "reach"}
CONVERT = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))


def vector(x, y, z):
    """Three.js (Y up) to Blender (Z up), preserving handedness."""
    return (x, -z, y)


def bounded(value, low, high, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{label} must be a finite number")
    if not low <= value <= high:
        raise ValueError(f"{label} is out of range")
    return float(value)


def parse_camera(cam):
    if not isinstance(cam, dict):
        raise ValueError("Invalid camera")
    return {key: bounded(cam.get(key), low, high, f"camera.{key}") for key, low, high in (
        ("x", -50, 50), ("y", .05, 30), ("z", -50, 50),
        ("tx", -50, 50), ("ty", -10, 30), ("tz", -50, 50), ("focal", 12, 200),
    )}


def parse_position(obj, figure=False):
    if not isinstance(obj, dict) or not isinstance(obj.get("id"), str) or not obj["id"]:
        raise ValueError("Invalid object identity")
    result = {"id": obj["id"][:64], "x": bounded(obj.get("x"), -50, 50, "x"),
              "z": bounded(obj.get("z"), -50, 50, "z"),
              "facing": bounded(obj.get("facing"), -360, 360, "facing")}
    if figure:
        if obj.get("pose") not in POSES:
            raise ValueError("Unsupported figure pose")
        result["pose"] = obj["pose"]
    return result


def read_document(filepath):
    path = Path(filepath)
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("File is too large")
    with path.open("r", encoding="utf-8") as file:
        data = json.load(file)
    if not isinstance(data, dict) or data.get("format") != "plein.stage" or data.get("version") != 1:
        raise ValueError("Not a supported Plein stage file")
    scene = data.get("scene")
    if not isinstance(scene, dict):
        raise ValueError("Missing scene")
    figures, blocks = scene.get("figures"), scene.get("blocks")
    if not isinstance(figures, list) or len(figures) > 12 or not isinstance(blocks, list) or len(blocks) > 60:
        raise ValueError("Too many or invalid objects")
    output = {"name": str(data.get("name", "Plein 构图"))[:120], "figures": [], "blocks": [],
              "camera": parse_camera(scene.get("camera")), "aspect": scene.get("aspect", "16:9")}
    if output["aspect"] not in {"16:9", "9:16", "4:3", "3:4", "1:1", "21:9"}:
        raise ValueError("Invalid aspect ratio")
    ids = set()
    for fig in figures:
        parsed = parse_position(fig, True)
        parsed.update(name=str(fig.get("name", "人物"))[:40],
                      height=bounded(fig.get("height"), .5, 2.5, "height"), color=fig.get("color"))
        color = parsed["color"]
        if not isinstance(color, str) or len(color) != 7 or color[0] != "#":
            raise ValueError("Invalid figure color")
        try:
            int(color[1:], 16)
        except ValueError:
            raise ValueError("Invalid figure color") from None
        if parsed["id"] in ids:
            raise ValueError("Duplicate object identity")
        ids.add(parsed["id"])
        output["figures"].append(parsed)
    for block in blocks:
        parsed = parse_position(block)
        if block.get("kind") not in KINDS:
            raise ValueError("Unsupported block kind")
        parsed.update(kind=block["kind"], name=str(block.get("name") or block["kind"])[:40],
                      w=bounded(block.get("w"), .05, 30, "width"),
                      h=bounded(block.get("h"), .05, 10, "height"),
                      d=bounded(block.get("d"), .05, 30, "depth"))
        if parsed["id"] in ids:
            raise ValueError("Duplicate object identity")
        ids.add(parsed["id"])
        output["blocks"].append(parsed)
    motion = scene.get("motion")
    output["motion"] = None
    if motion is not None:
        if not isinstance(motion, dict) or not isinstance(motion.get("keyframes"), list) or not 1 <= len(motion["keyframes"]) <= 60:
            raise ValueError("Invalid animation")
        duration = bounded(motion.get("duration"), 1, 60, "duration")
        frames = []
        for frame in motion["keyframes"]:
            if not isinstance(frame, dict) or not isinstance(frame.get("figures"), list) or len(frame["figures"]) > 12:
                raise ValueError("Invalid keyframe")
            positions = [parse_position(item, True) for item in frame["figures"]]
            figure_ids = {item["id"] for item in output["figures"]}
            if len({item["id"] for item in positions}) != len(positions) or any(item["id"] not in figure_ids for item in positions):
                raise ValueError("Invalid keyframe figure")
            frames.append({"time": bounded(frame.get("time"), 0, duration, "time"),
                           "camera": parse_camera(frame.get("camera")), "figures": positions})
        if len({item["time"] for item in frames}) != len(frames):
            raise ValueError("Duplicate keyframe time")
        output["motion"] = {"duration": duration, "keyframes": sorted(frames, key=lambda x: x["time"])}
    output["time"] = bounded(data.get("time", 0), 0, output["motion"]["duration"] if output["motion"] else 0, "current time")
    return output


def empty(collection, name, parent=None, position=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    collection.objects.link(obj)
    obj.parent = parent
    obj.location = vector(*position)
    return obj


def material(name, color):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.roughness = .9
    return mat


def mesh(collection, name, parent, shape, size, position, mat):
    if shape == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8)
    else:
        bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.object
    obj.name = name
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    collection.objects.link(obj)
    obj.parent = parent
    obj.location = vector(*position)
    # Unit sphere has diameter 2; unit cube has edge 1.
    k = .5 if shape == "sphere" else 1
    obj.scale = (size[0] * k, size[2] * k, size[1] * k)
    obj.data.materials.append(mat)
    return obj


def make_block(collection, b, mat):
    root = empty(collection, b["name"])
    root.location = vector(b["x"], 0, b["z"])
    root.rotation_euler.z = math.radians(b["facing"])
    root["plein_id"], root["plein_kind"] = b["id"], b["kind"]
    w, h, d = b["w"], b["h"], b["d"]
    def part(name, size, pos):
        return mesh(collection, name, root, "cube", size, pos, mat)
    def legs(top):
        leg = min(.06, w / 8, d / 8)
        for sx in (-1, 1):
            for sz in (-1, 1):
                part("支撑", (leg, top, leg), (sx * (w / 2 - leg), top / 2, sz * (d / 2 - leg)))
    if b["kind"] == "table":
        thick = min(.05, h / 6)
        part("桌面", (w, thick, d), (0, h - thick / 2, 0))
        legs(h - thick)
    elif b["kind"] == "chair":
        seat, thick = min(.46, h * .5), .04
        part("椅面", (w, thick, d), (0, seat, 0))
        part("椅背", (w, h - seat, thick), (0, seat + (h - seat) / 2, -d / 2 + thick / 2))
        legs(seat - thick / 2)
    elif b["kind"] == "bed":
        part("床", (w, h, d), (0, h / 2, 0))
        part("枕头", (w * .6, .1, min(.4, d / 4)), (0, h + .05, -d / 2 + .3))
    else:
        part(b["name"], (w, h, d), (0, h / 2, 0))
    return root


# Angles match the simple Plein mannequin; meshes are approximations, not a skinned rig.
POSE = {
    "stand": {}, "walk": {"armL": -22, "armR": 22, "legL": 22, "legR": -18},
    "run": {"lean": 12, "drop": .04, "armL": -45, "armR": 55, "legL": 50, "legR": -28, "elbowL": 85, "elbowR": 85, "kneeL": 75, "kneeR": 45},
    "sit": {"drop": .44, "armL": 25, "armR": 25, "elbowL": 55, "elbowR": 55, "legL": 90, "legR": 90, "kneeL": 90, "kneeR": 90},
    "point": {"armR": 85}, "cross": {"armL": 30, "armR": 30, "elbowL": 115, "elbowR": 115},
    "kneel": {"drop": .44, "lean": 6, "legL": 90, "kneeL": 90, "kneeR": 90},
    "reach": {"lean": 10, "armL": 55, "armR": 115, "legL": 18, "legR": -12},
}


def joint_rotation(obj, x=0, y=0, z=0):
    source = Euler(tuple(math.radians(v) for v in (x, y, z)), "YXZ").to_matrix()
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = (CONVERT @ source @ CONVERT.inverted()).to_quaternion()


def make_figure(collection, fig):
    color = tuple(int(fig["color"][i:i+2], 16) / 255 * .65 + .72 * .35 for i in (1, 3, 5))
    mat = material(fig["name"], color)
    root = empty(collection, fig["name"])
    root.location = vector(fig["x"], 0, fig["z"])
    root.rotation_euler.z = math.radians(fig["facing"])
    root["plein_id"] = fig["id"]
    body = empty(collection, "身体", root)
    body.scale = (fig["height"] / 1.73,) * 3
    pelvis = empty(collection, "骨盆", body, (0, .94, 0))
    mesh(collection, "骨盆", pelvis, "sphere", (.27, .2, .2), (0, 0, 0), mat)
    spine = empty(collection, "躯干", pelvis, (0, .05, 0))
    mesh(collection, "躯干", spine, "sphere", (.35, .54, .21), (0, .25, 0), mat)
    neck = empty(collection, "颈部", spine, (0, .5, 0))
    mesh(collection, "头", neck, "sphere", (.2, .23, .22), (0, .15, 0), mat)
    mesh(collection, "鼻", neck, "cube", (.03, .05, .05), (0, .14, .11), mat)
    rig = {"pelvis": pelvis, "spine": spine}
    for name, side in (("L", 1), ("R", -1)):
        arm = empty(collection, "肩" + name, spine, (.2 * side, .45, 0))
        mesh(collection, "上臂" + name, arm, "sphere", (.09, .31, .09), (0, -.14, 0), mat)
        elbow = empty(collection, "肘" + name, arm, (0, -.3, 0))
        mesh(collection, "前臂" + name, elbow, "sphere", (.08, .26, .08), (0, -.12, 0), mat)
        hip = empty(collection, "髋" + name, pelvis, (.1 * side, 0, 0))
        mesh(collection, "大腿" + name, hip, "sphere", (.14, .44, .14), (0, -.22, 0), mat)
        knee = empty(collection, "膝" + name, hip, (0, -.44, 0))
        mesh(collection, "小腿" + name, knee, "sphere", (.11, .43, .11), (0, -.22, 0), mat)
        mesh(collection, "脚" + name, knee, "cube", (.09, .06, .22), (0, -.47, .05), mat)
        rig.update({"arm" + name: arm, "elbow" + name: elbow, "leg" + name: hip, "knee" + name: knee})
    apply_pose(rig, fig["pose"])
    return root, rig


def apply_pose(rig, name):
    p = POSE[name]
    rig["pelvis"].location = vector(0, .94 - p.get("drop", 0), 0)
    joint_rotation(rig["spine"], p.get("lean", 0))
    for side in ("L", "R"):
        joint_rotation(rig["arm" + side], -p.get("arm" + side, 0))
        joint_rotation(rig["elbow" + side], -p.get("elbow" + side, 0))
        joint_rotation(rig["leg" + side], -p.get("leg" + side, 0))
        joint_rotation(rig["knee" + side], p.get("knee" + side, 0))


def set_camera(obj, cam):
    obj.location = vector(cam["x"], cam["y"], cam["z"])
    target = Vector(vector(cam["tx"], cam["ty"], cam["tz"]))
    direction = target - obj.location
    if direction.length < 1e-6:
        direction = Vector((0, 1, 0))
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = direction.to_track_quat("-Z", "Y")
    obj.data.lens = cam["focal"]
    obj.data.sensor_width = 36
    obj.data.sensor_height = 36


def import_document(document, context):
    scene = context.scene
    collection = bpy.data.collections.new(document["name"] or "Plein 构图")
    scene.collection.children.link(collection)
    grey = material("Plein 灰模", (.65, .67, .7))
    for block in document["blocks"]:
        make_block(collection, block, grey)
    figures = {fig["id"]: make_figure(collection, fig) for fig in document["figures"]}
    camera_data = bpy.data.cameras.new("Plein 机位")
    camera = bpy.data.objects.new("Plein 机位", camera_data)
    collection.objects.link(camera)
    set_camera(camera, document["camera"])
    scene.camera = camera
    scene.render.fps = FPS
    w, h = (int(x) for x in document["aspect"].split(":"))
    camera_data.sensor_fit = "HORIZONTAL" if w >= h else "VERTICAL"
    scene.render.resolution_x, scene.render.resolution_y = (1536, round(1536 * h / w)) if w >= h else (round(1536 * w / h), 1536)
    scene.render.resolution_percentage = 100
    if document["motion"]:
        scene.frame_start, scene.frame_end = 1, 1 + math.ceil(document["motion"]["duration"] * FPS)
        for key in document["motion"]["keyframes"]:
            frame = 1 + key["time"] * FPS
            set_camera(camera, key["camera"])
            camera.keyframe_insert(data_path="location", frame=frame)
            camera.keyframe_insert(data_path="rotation_quaternion", frame=frame)
            camera_data.keyframe_insert(data_path="lens", frame=frame)
            overrides = {fig["id"]: fig for fig in key["figures"]}
            for base in document["figures"]:
                fig = overrides.get(base["id"], base)
                root, rig = figures[fig["id"]]
                root.location = vector(fig["x"], 0, fig["z"])
                root.rotation_euler.z = math.radians(fig["facing"])
                root.keyframe_insert(data_path="location", frame=frame)
                root.keyframe_insert(data_path="rotation_euler", frame=frame)
                apply_pose(rig, fig["pose"])
                for joint in rig.values():
                    joint.keyframe_insert(data_path="location", frame=frame)
                    if joint.rotation_mode == "QUATERNION":
                        joint.keyframe_insert(data_path="rotation_quaternion", frame=frame)
        current_frame = 1 + document["time"] * FPS
        whole = math.floor(current_frame)
        scene.frame_set(whole, subframe=current_frame - whole)
    return collection


class PLEIN_OT_import_stage(bpy.types.Operator, ImportHelper):
    bl_idname = "import_scene.plein_stage"
    bl_label = "导入 Plein 3D 构图"
    bl_options = {"REGISTER", "UNDO"}
    filename_ext = ".json"
    filter_glob: StringProperty(default="*.plein-stage.json;*.json", options={"HIDDEN"})

    def execute(self, context):
        try:
            document = read_document(self.filepath)
            import_document(document, context)
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
            self.report({"ERROR"}, f"无法导入 Plein 构图：{error}")
            return {"CANCELLED"}
        self.report({"INFO"}, "Plein 构图已导入；材质和人偶为简化白模")
        return {"FINISHED"}


def render_for_plein(scene, filepath, animation):
    """Render through Blender's current camera and engine, restoring output settings."""
    render = scene.render
    old_path, old_format = render.filepath, render.image_settings.file_format
    old_media = getattr(render.image_settings, "media_type", None)
    old_container, old_codec = render.ffmpeg.format, render.ffmpeg.codec
    old_frame, old_subframe = scene.frame_current, scene.frame_subframe
    try:
        render.filepath = filepath
        if old_media is not None:
            render.image_settings.media_type = "VIDEO" if animation else "IMAGE"
        if animation:
            render.image_settings.file_format = "FFMPEG"
            render.ffmpeg.format = "MPEG4"
            render.ffmpeg.codec = "H264"
            bpy.ops.render.render(animation=True)
        else:
            render.image_settings.file_format = "PNG"
            bpy.ops.render.render(write_still=True)
    finally:
        render.filepath = old_path
        if old_media is not None:
            render.image_settings.media_type = old_media
        render.image_settings.file_format = old_format
        render.ffmpeg.format = old_container
        render.ffmpeg.codec = old_codec
        scene.frame_set(old_frame, subframe=old_subframe)


class PLEIN_OT_render_image(bpy.types.Operator, ExportHelper):
    bl_idname = "export_scene.plein_render_image"
    bl_label = "渲染图片供 Plein 导入"
    filename_ext = ".png"
    filter_glob: StringProperty(default="*.png", options={"HIDDEN"})

    def execute(self, context):
        try:
            render_for_plein(context.scene, self.filepath, False)
        except (RuntimeError, OSError, ValueError, TypeError) as error:
            self.report({"ERROR"}, f"渲染失败：{error}")
            return {"CANCELLED"}
        self.report({"INFO"}, "图片已保存；在 Plein 的 3D 构图中选择导入 Blender 渲染")
        return {"FINISHED"}


class PLEIN_OT_render_video(bpy.types.Operator, ExportHelper):
    bl_idname = "export_scene.plein_render_video"
    bl_label = "渲染视频供 Plein 导入"
    filename_ext = ".mp4"
    filter_glob: StringProperty(default="*.mp4", options={"HIDDEN"})

    def execute(self, context):
        try:
            render_for_plein(context.scene, self.filepath, True)
        except (RuntimeError, OSError, ValueError, TypeError) as error:
            self.report({"ERROR"}, f"渲染失败：{error}")
            return {"CANCELLED"}
        self.report({"INFO"}, "视频已保存；在 Plein 的 3D 构图中选择导入 Blender 渲染")
        return {"FINISHED"}


class PLEIN_PT_bridge(bpy.types.Panel):
    bl_label = "Plein"
    bl_idname = "PLEIN_PT_bridge"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Plein"

    def draw(self, _context):
        self.layout.operator(PLEIN_OT_import_stage.bl_idname, text="导入 Plein 构图")
        self.layout.operator(PLEIN_OT_render_image.bl_idname, text="渲染图片供 Plein 导入")
        self.layout.operator(PLEIN_OT_render_video.bl_idname, text="渲染视频供 Plein 导入")


def menu_func(self, _context):
    self.layout.operator(PLEIN_OT_import_stage.bl_idname, text="Plein 3D 构图 (.json)")


def register():
    bpy.utils.register_class(PLEIN_OT_import_stage)
    bpy.utils.register_class(PLEIN_OT_render_image)
    bpy.utils.register_class(PLEIN_OT_render_video)
    bpy.utils.register_class(PLEIN_PT_bridge)
    bpy.types.TOPBAR_MT_file_import.append(menu_func)


def unregister():
    bpy.types.TOPBAR_MT_file_import.remove(menu_func)
    bpy.utils.unregister_class(PLEIN_PT_bridge)
    bpy.utils.unregister_class(PLEIN_OT_render_video)
    bpy.utils.unregister_class(PLEIN_OT_render_image)
    bpy.utils.unregister_class(PLEIN_OT_import_stage)


if __name__ == "__main__":
    register()
