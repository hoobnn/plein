"""Run with Blender: blender -b --factory-startup --python-exit-code 1 --python this_file."""
import importlib.util
import json
import math
from pathlib import Path
import tempfile

import bpy

addon = Path(__file__).resolve().parents[1] / 'public' / 'plein_blender_bridge.py'
spec = importlib.util.spec_from_file_location('plein_blender_bridge', addon)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
bridge.register()

camera = {'x': 1, 'y': 1.5, 'z': 3, 'tx': 0, 'ty': 1, 'tz': 0, 'focal': 35}
figure = {'id': 'person', 'name': '人物', 'color': '#7aa2ff', 'x': 0, 'z': 0,
          'facing': 90, 'pose': 'sit', 'height': 1.7}
block = {'id': 'desk', 'kind': 'table', 'name': '桌', 'x': 2, 'z': -1,
         'facing': 0, 'w': 1.4, 'h': .75, 'd': .8}
document = {
    'format': 'plein.stage', 'version': 1, 'name': '导入测试', 'time': .03,
    'scene': {
        'aspect': '9:16', 'figures': [figure], 'blocks': [block], 'camera': camera,
        'motion': {'duration': 2, 'keyframes': [
            {'time': 0, 'camera': camera, 'figures': []},
            {'time': .03, 'camera': {**camera, 'x': 2, 'focal': 50},
             'figures': [{**figure, 'x': 1, 'pose': 'stand'}]},
        ]},
    },
}

try:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'scene.plein-stage.json'
        path.write_text(json.dumps(document), encoding='utf-8')
        assert bpy.ops.import_scene.plein_stage(filepath=str(path)) == {'FINISHED'}
        collection = bpy.data.collections['导入测试']
        objects = {obj.get('plein_id'): obj for obj in collection.objects if obj.get('plein_id')}
        assert set(objects) == {'person', 'desk'}
        scene = bpy.context.scene
        assert scene.render.fps == 24 and scene.camera.data.sensor_fit == 'VERTICAL'
        assert (scene.camera.location - bridge.Vector(bridge.vector(2, 1.5, 3))).length < 1e-4
        assert abs(objects['person'].location.x - 1) < 1e-4
        assert math.isclose(scene.frame_current_final, 1 + .03 * 24, abs_tol=1e-5)
        assert scene.render.resolution_y == 1536

        # Exercise the real return-media render and ensure the user's settings survive.
        scene.render.engine = 'BLENDER_WORKBENCH'
        scene.render.resolution_x = scene.render.resolution_y = 64
        scene.render.resolution_percentage = 100
        scene.frame_end = 2
        original = (scene.render.filepath, scene.render.image_settings.file_format,
                    scene.render.ffmpeg.format, scene.render.ffmpeg.codec, scene.frame_current_final)
        image_path = Path(directory) / 'render.png'
        assert bpy.ops.export_scene.plein_render_image(filepath=str(image_path)) == {'FINISHED'}
        assert image_path.is_file() and image_path.stat().st_size > 0
        video_path = Path(directory) / 'render.mp4'
        assert bpy.ops.export_scene.plein_render_video(filepath=str(video_path)) == {'FINISHED'}
        assert any(p.stat().st_size > 0 for p in Path(directory).glob('render*.mp4'))
        assert (scene.render.filepath, scene.render.image_settings.file_format,
                scene.render.ffmpeg.format, scene.render.ffmpeg.codec, scene.frame_current_final) == original

        # Validate before mutating the user's existing scene.
        path.write_text(json.dumps({**document, 'version': 99}), encoding='utf-8')
        before = set(bpy.data.collections.keys())
        try:
            result = bpy.ops.import_scene.plein_stage(filepath=str(path))
            assert result == {'CANCELLED'}
        except RuntimeError:
            pass  # Blender raises for an operator reporting ERROR.
        assert set(bpy.data.collections.keys()) == before
    print('Plein Blender bridge integration passed')
finally:
    bridge.unregister()
