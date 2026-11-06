"""Regenerate the bundled app icon; requires Pillow only for this optional task."""
from pathlib import Path
from PIL import Image, ImageDraw

scale = 4
image = Image.new("RGBA", (256 * scale, 256 * scale), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((0, 0, 255 * scale, 255 * scale), radius=45 * scale, fill="#04120d")
draw.rounded_rectangle((18 * scale, 18 * scale, 238 * scale, 238 * scale), radius=29 * scale, outline="#00ed9d", width=3 * scale)
points = [(38, 130), (75, 130), (98, 67), (130, 200), (160, 67), (181, 130), (219, 130)]
draw.line([(x * scale, y * scale) for x, y in points], fill="#00ed9d", width=13 * scale, joint="curve")
image.resize((256, 256), Image.Resampling.LANCZOS).save(Path(__file__).resolve().parents[1] / "app.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
