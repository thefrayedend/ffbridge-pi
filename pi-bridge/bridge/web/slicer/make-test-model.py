#!/usr/bin/env python3
"""Writes a small test project the same way the web slicer does (web/slicer/project3mf.js):
two 20 mm cubes, the second one on filament 2, and the top of the first one painted with
filament 2.   python3 make-test-model.py OUT.3mf"""
import sys
import zipfile

NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"


def cube(ox, oy, s=20.0):
    v = [(ox + x * s, oy + y * s, z * s) for x in (0, 1) for y in (0, 1) for z in (0, 1)]
    f = [(0, 2, 3), (0, 3, 1), (4, 5, 7), (4, 7, 6), (0, 1, 5), (0, 5, 4), (2, 6, 7), (2, 7, 3), (0, 4, 6), (0, 6, 2), (1, 3, 7), (1, 7, 5)]
    return v, f


def paint_code(state):
    return format(state * 4, "X") if state < 3 else format(state - 3, "X") + "C"


objs = []
for i, (ox, filament) in enumerate(((110, 1), (140, 2)), 1):
    v, f = cube(ox, 118)
    paint = {}
    if i == 1:  # top faces (z = 20 for all three corners) painted with filament 2
        for n, t in enumerate(f):
            if all(v[k][2] == 20 for k in t):
                paint[n] = 2
    objs.append((i, v, f, filament, paint))

model = [f'<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="{NS}" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">',
         '<metadata name="Application">FlashForge Bridge</metadata><resources>']
build = ["<build>"]
cfg = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>']
for i, v, f, filament, paint in objs:
    model.append(f'<object id="{i}" type="model" name="cube{i}"><mesh><vertices>')
    model += [f'<vertex x="{x:g}" y="{y:g}" z="{z:g}"/>' for x, y, z in v]
    model.append("</vertices><triangles>")
    for n, t in enumerate(f):
        p = f' paint_color="{paint_code(paint[n])}"' if n in paint else ""
        model.append(f'<triangle v1="{t[0]}" v2="{t[1]}" v3="{t[2]}"{p}/>')
    model.append("</triangles></mesh></object>")
    build.append(f'<item objectid="{i}" printable="1"/>')
    cfg.append(f'<object id="{i}"><metadata key="name" value="cube{i}"/><metadata key="extruder" value="{filament}"/>'
               f'<part id="{i}" subtype="normal_part"><metadata key="name" value="cube{i}"/><metadata key="extruder" value="{filament}"/></part></object>')
model += ["</resources>"] + build + ["</build></model>"]
cfg.append('<plate><metadata key="plater_id" value="1"/>' + "".join(
    f'<model_instance><metadata key="object_id" value="{i}"/><metadata key="instance_id" value="0"/></model_instance>' for i, *_ in objs) + "</plate></config>")

with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
               '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
               '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
    z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    z.writestr("3D/3dmodel.model", "".join(model))
    z.writestr("Metadata/model_settings.config", "".join(cfg))
