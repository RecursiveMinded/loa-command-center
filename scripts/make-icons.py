"""Draws the app icon (build/icon.png and build/icon.ico). Run: npm run icons"""
from PIL import Image, ImageDraw
import os

S = 1024
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
# Diagonal blue-to-violet gradient in a rounded square.
grad = Image.new('RGBA', (S, S))
px = grad.load()
a, b = (36, 86, 214), (123, 92, 255)
for y in range(S):
    for x in range(S):
        t = (x + y) / (2 * S)
        px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=220, fill=255)
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)
# A document with a folded corner...
d.rounded_rectangle([290, 200, 734, 800], radius=48, fill=(255, 255, 255, 255))
d.polygon([(600, 200), (734, 334), (600, 334)], fill=(205, 216, 250, 255))
for i, w in enumerate([300, 250, 280]):
    y = 400 + i * 80
    d.rounded_rectangle([360, y, 360 + w, y + 30], radius=15, fill=(196, 206, 232, 255))
# ...and a green approval check badge.
d.ellipse([560, 600, 840, 880], fill=(31, 143, 90, 255), outline=(255, 255, 255, 255), width=24)
d.line([(625, 742), (683, 800), (785, 688)], fill=(255, 255, 255, 255), width=40, joint='curve')
os.makedirs('build', exist_ok=True)
img.resize((512, 512), Image.LANCZOS).save('build/icon.png')
img.save('build/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('wrote build/icon.png and build/icon.ico')
