import zlib, struct, math

def make_png(width, height, color_func):
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    raw_data = bytearray()
    for y in range(height):
        raw_data.append(0)
        for x in range(width):
            r, g, b, a = color_func(x, y, width, height)
            raw_data.extend([int(r), int(g), int(b), int(a)])

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(raw_data))) + chunk(b'IEND', b'')
    return png

def icon_color(x, y, w, h):
    # Normalized coords from -1 to 1
    nx = (x + 0.5) / w * 2.0 - 1.0
    ny = (y + 0.5) / h * 2.0 - 1.0
    
    # Rounded corner box background (radius ~ 0.85)
    corner_r = 0.28
    ax = max(0.0, abs(nx) - (1.0 - corner_r))
    ay = max(0.0, abs(ny) - (1.0 - corner_r))
    dist_corner = math.sqrt(ax * ax + ay * ay)
    
    if dist_corner > corner_r:
        return 0, 0, 0, 0  # Transparent outside rounded box
    
    # Background gradient: vibrant emerald green to deep teal
    t = (ny + 1.0) * 0.5
    bg_r = 16 * (1 - t) + 13 * t
    bg_g = 185 * (1 - t) + 148 * t
    bg_b = 129 * (1 - t) + 136 * t
    
    # Circular emblem / arrow / 'L' symbol in center
    dist_center = math.sqrt(nx * nx + ny * ny)
    
    # Draw a stylized circular ring with gap and arrow (refresh / automation theme)
    # Ring between radius 0.40 and 0.65
    angle = math.atan2(ny, nx) # -pi to pi
    
    is_symbol = False
    # Circular arc
    if 0.40 <= dist_center <= 0.62:
        if not (-0.5 < angle < 0.2): # small gap on right
            is_symbol = True
    
    # Arrow head near gap
    if 0.15 <= nx <= 0.65 and -0.45 <= ny <= -0.05:
        # Check triangle or chevron
        if abs(nx - 0.42) + abs(ny - (-0.25)) < 0.22:
            is_symbol = True

    # Center dot / rupee notch
    if dist_center < 0.22:
        is_symbol = True

    if is_symbol:
        # White symbol with smooth brightness
        return 255, 255, 255, 255
    else:
        return bg_r, bg_g, bg_b, 255

for size in [16, 32, 48, 128]:
    png_bytes = make_png(size, size, icon_color)
    with open(f"icons/icon{size}.png", "wb") as f:
        f.write(png_bytes)
    print(f"Generated icons/icon{size}.png ({len(png_bytes)} bytes)")
