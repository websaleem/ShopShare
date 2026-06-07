import sys
from PIL import Image, ImageOps, ImageEnhance, ImageStat

def main():
    icon_path = 'icon.png'
    try:
        img = Image.open(icon_path).convert("RGBA")
    except Exception as e:
        print(f"Error opening icon.png: {e}")
        return

    # 1. Favicon: just resize to 192x192
    fav = img.resize((192, 192), Image.Resampling.LANCZOS)
    fav.save('favicon.png')
    print("Created favicon.png")

    # 2. Android Icon Background
    bg = Image.new("RGBA", (1024, 1024), (26, 26, 26, 255)) # #1a1a1a
    bg.save('android-icon-background.png')
    print("Created android-icon-background.png")

    # 3. Android Icon Monochrome
    gray = img.convert("L")
    stat = ImageStat.Stat(gray)
    mean = stat.mean[0]
    
    mask = gray.point(lambda p: 255 if p > mean else 0)
    
    mono = Image.new("RGBA", (1024, 1024), (255, 255, 255, 255))
    mono.putalpha(mask)
    mono.save('android-icon-monochrome.png')
    print("Created android-icon-monochrome.png")

if __name__ == '__main__':
    main()
