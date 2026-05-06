import sys
import os
from PIL import Image, ImageChops, ImageStat

def compare_images(img1_path, img2_path, diff_path):
    try:
        if not os.path.exists(img1_path) or not os.path.exists(img2_path):
            return None

        img1 = Image.open(img1_path).convert('RGB')
        img2 = Image.open(img2_path).convert('RGB')

        if img1.size != img2.size:
            return 100.0

        diff = ImageChops.difference(img1, img2)
        stat = ImageStat.Stat(diff)
        
        # Calculate percentage of different pixels
        # sum of differences / (width * height * 3 color channels * 255 max diff)
        diff_sum = sum(stat.sum)
        max_diff = img1.size[0] * img1.size[1] * 3 * 255
        percentage = (diff_sum / max_diff) * 100
        
        if percentage > 0:
            # Create a visual diff: highlight differences in red
            # This is a simple way to visualize where the changes are
            diff.save(diff_path)
            
        return percentage
    except Exception as e:
        print(f"Error: {e}")
        return None

if __name__ == "__main__":
    if len(sys.argv) < 4:
        sys.exit(1)
    
    p = compare_images(sys.argv[1], sys.argv[2], sys.argv[3])
    if p is not None:
        print(f"{p:.6f}")
    else:
        sys.exit(1)
